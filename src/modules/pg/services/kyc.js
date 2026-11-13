const Tenant = require('../models/Tenant');
const TenantDocument = require('../models/TenantDocument');

/**
 * Derive the tenant's KYC status from their ID-proof documents:
 * VERIFIED once any ID proof is verified; REJECTED when the latest ID proof
 * was rejected and none is verified; otherwise PENDING.
 */
const recomputeKyc = async (organizationId, tenantId) => {
  const docs = await TenantDocument.find({ organizationId, tenantId, type: 'ID_PROOF' }).sort({ createdAt: -1 }).lean();
  let status = 'PENDING';
  if (docs.some(d => d.status === 'VERIFIED')) status = 'VERIFIED';
  else if (docs[0] && docs[0].status === 'REJECTED') status = 'REJECTED';
  await Tenant.updateOne({ _id: tenantId, organizationId }, { $set: { kycStatus: status } });
  return status;
};

module.exports = { recomputeKyc };
