const { createRouter } = require('../../core/router');
const { z, text, id, idParams, listQuery } = require('../../core/validation');
const TenantDocument = require('../models/TenantDocument');
const Tenant = require('../models/Tenant');
const { uploadSingle, storeUpload, signedUrl, removeFile } = require('../../storage');
const { maskIdNumber } = require('../services/visitors');
const { recomputeKyc } = require('../services/kyc');
const { listOptions, paginate } = require('../../core/query');
const { loadOwned } = require('../../core/refs');
const { publicDoc } = require('../../core/schema');
const { uploadLimiter } = require('../../core/rateLimits');
const { audit } = require('../../core/audit');
const { validation } = require('../../core/errors');
const errors = require('../../core/errors');
const { notify } = require('../../notifications/dispatcher');

const r = createRouter({ prefix: '/pg/documents', tag: 'Documents' });

const TYPES = ['ID_PROOF', 'ADDRESS_PROOF', 'AGREEMENT', 'PHOTO', 'OTHER'];
const SUBTYPES = ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER'];

const UploadFields = z.object({
  tenantId: id,
  type: z.enum(TYPES),
  subType: z.enum(SUBTYPES).optional(),
  docNumber: z.string().trim().max(40).optional(),
  notes: text(500).optional(),
});

// Never return storage keys; expose file metadata only.
const safe = doc => {
  const d = publicDoc(doc);
  delete d.fileKey;
  return d;
};

/** Shared by the staff and tenant upload endpoints. */
const saveDocument = async (req, { tenantId, type, subType, docNumber, notes }, uploaderRole) => {
  const stored = await storeUpload(req.file, `${req.ctx.orgId}/tenants/${tenantId}`);
  const doc = await TenantDocument.create({
    organizationId: req.ctx.orgId,
    tenantId,
    type,
    subType: subType || null,
    docNumberMasked: maskIdNumber(docNumber),
    fileKey: stored.key,
    fileName: stored.fileName,
    mimeType: stored.mimeType,
    size: stored.size,
    storageDriver: stored.driver,
    uploadedBy: req.user._id,
    uploadedByRole: uploaderRole,
    notes: notes || '',
  });
  if (type === 'ID_PROOF') await recomputeKyc(req.ctx.orgId, tenantId);
  audit(req, { action: 'document.upload', entityType: 'TenantDocument', entityId: doc._id, summary: `${type} uploaded` });
  return safe(doc.toJSON());
};

const parseFields = req => {
  const parsed = UploadFields.safeParse(req.body || {});
  if (!parsed.success) throw validation(parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
  return parsed.data;
};

r.get(
  '/',
  {
    permission: 'document.read',
    feature: 'documentStorage',
    query: listQuery({ tenantId: id.optional(), status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional(), type: z.enum(TYPES).optional() }),
    summary: 'List tenant documents',
  },
  async req => {
    const q = req.valid.query;
    const filter = { organizationId: req.ctx.orgId };
    if (q.tenantId) {
      await loadOwned(Tenant, q.tenantId, req, { entity: 'Tenant', propertyField: 'current.propertyId', lean: true });
      filter.tenantId = q.tenantId;
    }
    if (q.status) filter.status = q.status;
    if (q.type) filter.type = q.type;
    const page = await paginate(TenantDocument, filter, listOptions(q, { sortable: ['createdAt'] }), { select: '-fileKey' });
    const tenants = await Tenant.find({ organizationId: req.ctx.orgId, _id: { $in: [...new Set(page.items.map(d => d.tenantId))] } })
      .select('fullName')
      .lean();
    const nameOf = new Map(tenants.map(t => [t._id, t.fullName]));
    page.items = page.items.map(d => ({ ...d, tenantName: nameOf.get(d.tenantId) || '' }));
    return page;
  },
);

r.post(
  '/',
  {
    permission: 'document.upload',
    feature: 'documentStorage',
    middleware: [uploadLimiter, uploadSingle('file')],
    success: 201,
    multipart: {
      type: 'object',
      required: ['file', 'tenantId', 'type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        tenantId: { type: 'string', format: 'uuid' },
        type: { type: 'string', enum: TYPES },
        subType: { type: 'string', enum: SUBTYPES },
        docNumber: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    summary: 'Upload a KYC / agreement document (multipart)',
  },
  async req => {
    const fields = parseFields(req);
    await loadOwned(Tenant, fields.tenantId, req, { entity: 'Tenant', propertyField: 'current.propertyId', lean: true });
    return saveDocument(req, fields, req.ctx.role);
  },
);

// Short-lived signed URL; documents are never publicly addressable.
r.get('/:id/url', { permission: 'document.read', params: idParams, summary: 'Signed, expiring download URL' }, async req => {
  const doc = await loadOwned(TenantDocument, req.valid.params.id, req, { entity: 'Document', propertyField: null, lean: true });
  await loadOwned(Tenant, doc.tenantId, req, { entity: 'Document', propertyField: 'current.propertyId', lean: true });
  audit(req, { action: 'document.view', entityType: 'TenantDocument', entityId: doc._id });
  return signedUrl(doc.fileKey, doc.storageDriver, { filename: doc.fileName, mimeType: doc.mimeType });
});

const ReviewDto = z.object({ reason: text(300).optional() });

const review = status => async req => {
  const doc = await loadOwned(TenantDocument, req.valid.params.id, req, { entity: 'Document', propertyField: null });
  await loadOwned(Tenant, doc.tenantId, req, { entity: 'Document', propertyField: 'current.propertyId', lean: true });
  if (status === 'REJECTED' && !req.valid.body.reason) throw errors.badRequest('Give a reason for rejecting.', 'VALIDATION_ERROR');
  doc.status = status;
  doc.verifiedBy = req.user._id;
  doc.verifiedAt = new Date();
  doc.rejectionReason = status === 'REJECTED' ? req.valid.body.reason : '';
  await doc.save();
  const kycStatus = await recomputeKyc(req.ctx.orgId, doc.tenantId);
  audit(req, { action: `document.${status.toLowerCase()}`, entityType: 'TenantDocument', entityId: doc._id, summary: req.valid.body.reason || '' });
  const tenant = await Tenant.findOne({ _id: doc.tenantId, organizationId: req.ctx.orgId }).select('userId').lean();
  if (tenant && tenant.userId) {
    notify({
      userIds: [tenant.userId],
      organizationId: req.ctx.orgId,
      type: 'document_update',
      title: status === 'VERIFIED' ? 'Document verified' : 'Document rejected',
      body: status === 'VERIFIED' ? 'Your document has been verified.' : `Please re-upload: ${req.valid.body.reason}`,
      data: { route: 'documents' },
    });
  }
  return { ...safe(doc.toJSON()), kycStatus };
};

r.post('/:id/verify', { permission: 'document.verify', params: idParams, body: ReviewDto, summary: 'Mark a document verified' }, review('VERIFIED'));
r.post('/:id/reject', { permission: 'document.verify', params: idParams, body: ReviewDto, summary: 'Reject a document' }, review('REJECTED'));

r.delete('/:id', { permission: 'document.upload', params: idParams, summary: 'Delete a document' }, async req => {
  const doc = await loadOwned(TenantDocument, req.valid.params.id, req, { entity: 'Document', propertyField: null });
  await loadOwned(Tenant, doc.tenantId, req, { entity: 'Document', propertyField: 'current.propertyId', lean: true });
  await doc.softDelete(req.user._id);
  await removeFile(doc.fileKey, doc.storageDriver);
  if (doc.type === 'ID_PROOF') await recomputeKyc(req.ctx.orgId, doc.tenantId);
  audit(req, { action: 'document.delete', entityType: 'TenantDocument', entityId: doc._id });
  return { id: doc._id, deleted: true };
});

module.exports = { router: r.router, saveDocument, parseFields, safe };
