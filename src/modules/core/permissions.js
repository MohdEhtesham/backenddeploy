// Granular permission catalog + default role matrix.
//
// These are the SEED values: they are written to the saas_permissions /
// saas_roles collections on boot (idempotently) and the server always
// resolves permissions from the database, never from the client.

const PERMISSIONS = {
  // Organization & SaaS
  'org.read': 'View organization profile',
  'org.update': 'Edit organization profile & settings',
  'org.members.read': 'View team members',
  'org.members.manage': 'Invite / change / remove team members',
  'org.billing.manage': 'Manage subscription & billing',
  'org.audit.read': 'View the organization audit log',
  'support.manage': 'Raise and reply to support tickets',

  // Structure
  'property.read': 'View PG properties',
  'property.create': 'Create PG properties',
  'property.update': 'Edit PG properties',
  'property.delete': 'Delete PG properties',
  'structure.read': 'View buildings, floors, rooms and beds',
  'structure.manage': 'Create / edit / delete buildings, floors, rooms and beds',
  'bed.status.update': 'Block / unblock beds, mark maintenance, reserve',
  'amenity.manage': 'Manage the amenity catalog',

  // Tenants
  'tenant.read': 'View tenants',
  'tenant.create': 'Add tenants / prospects',
  'tenant.update': 'Edit tenants, record notice, transfer beds',
  'tenant.delete': 'Delete tenant records',
  'document.read': 'View tenant documents (signed URLs)',
  'document.upload': 'Upload tenant documents',
  'document.verify': 'Verify / reject KYC documents',
  'agreement.manage': 'Create and end tenant agreements',
  'checkin.create': 'Check tenants in',
  'checkout.create': 'Check tenants out and settle',

  // Money
  'rent.read': 'View rent configuration',
  'rent.manage': 'Change rent, charges and discounts',
  'invoice.read': 'View invoices',
  'invoice.create': 'Create one-off invoices / add charges',
  'invoice.update': 'Edit invoice lines',
  'invoice.cancel': 'Cancel invoices',
  'invoice.generate': 'Run monthly invoice generation',
  'payment.read': 'View payments & receipts',
  'payment.record': 'Record cash / UPI / bank / card payments',
  'payment.refund': 'Refund payments and settle deposits',
  'expense.read': 'View expenses',
  'expense.manage': 'Create / edit / delete expenses and categories',

  // Operations
  'complaint.read': 'View complaints',
  'complaint.create': 'Log complaints on behalf of tenants',
  'complaint.update': 'Update complaint status',
  'complaint.assign': 'Assign complaints to staff',
  'maintenance.read': 'View maintenance tasks',
  'maintenance.manage': 'Create / edit maintenance tasks',
  'maintenance.assign': 'Assign maintenance tasks',
  'maintenance.update': 'Update maintenance task status',
  'staff.read': 'View staff',
  'staff.manage': 'Create / edit / remove staff',
  'attendance.read': 'View staff attendance',
  'attendance.mark': 'Mark staff attendance',
  'visitor.read': 'View visitors',
  'visitor.create': 'Register walk-in visitors',
  'visitor.approve': 'Approve / reject visitor requests',
  'visitor.checkin': 'Check visitors in / out at the gate',
  'notice.read': 'View notices',
  'notice.manage': 'Publish / edit / delete notices',
  'mess.read': 'View mess menu & meal counts',
  'mess.manage': 'Edit mess menu',
  'mess.attendance.mark': 'Mark meal attendance',

  // Insights
  'dashboard.read': 'View the owner dashboard',
  'report.read': 'View reports',
  'report.advanced': 'View advanced reports',
  'report.export': 'Export reports (CSV)',
  'notification.send': 'Send custom notifications',

  // Tenant self-service (only ever granted to the TENANT role)
  'self.read': 'View own stay, invoices and receipts',
  'self.pay': 'Pay own rent online',
  'self.complaint': 'Raise and track own complaints',
  'self.visitor': 'Request visitor passes',
  'self.document': 'Upload own documents',
  'self.mess': 'Opt in / out of meals',
};

const ALL = Object.keys(PERMISSIONS);
const SELF = ALL.filter(p => p.startsWith('self.'));
const STAFF_SIDE = ALL.filter(p => !p.startsWith('self.'));
const pick = (...prefixes) => STAFF_SIDE.filter(p => prefixes.some(pre => p === pre || p.startsWith(`${pre}.`)));

const ROLE_KEYS = [
  'OWNER',
  'PROPERTY_MANAGER',
  'ACCOUNTANT',
  'RECEPTIONIST',
  'SECURITY',
  'STAFF',
  'TENANT',
];

// SUPER_ADMIN is a platform role (legacy User.role === 'admin'); it acts
// through /api/pg/admin/* and is not an organization membership.
const ROLE_DEFS = {
  SUPER_ADMIN: { name: 'Super Admin', description: 'Platform administrator', permissions: [] },
  OWNER: {
    name: 'Owner',
    description: 'Full control of the organization',
    permissions: STAFF_SIDE,
  },
  PROPERTY_MANAGER: {
    name: 'Property Manager',
    description: 'Runs day-to-day operations of assigned properties',
    permissions: STAFF_SIDE.filter(
      p =>
        ![
          'org.update',
          'org.members.manage',
          'org.billing.manage',
          'org.audit.read',
          'property.delete',
          'tenant.delete',
          'payment.refund',
          'invoice.cancel',
        ].includes(p),
    ),
  },
  ACCOUNTANT: {
    name: 'Accountant',
    description: 'Rent, invoices, payments, expenses and reports',
    permissions: [
      'org.read',
      'property.read',
      'structure.read',
      'tenant.read',
      'dashboard.read',
      ...pick('rent', 'invoice', 'payment', 'expense', 'report'),
    ],
  },
  RECEPTIONIST: {
    name: 'Receptionist',
    description: 'Front desk: tenants, check-in/out, visitors, collections',
    permissions: [
      'org.read',
      'property.read',
      'structure.read',
      'tenant.read',
      'tenant.create',
      'tenant.update',
      'document.read',
      'document.upload',
      'agreement.manage',
      'checkin.create',
      'checkout.create',
      'rent.read',
      'invoice.read',
      'payment.read',
      'payment.record',
      'complaint.read',
      'complaint.create',
      'complaint.update',
      'maintenance.read',
      'maintenance.manage',
      ...pick('visitor'),
      'notice.read',
      'mess.read',
      'dashboard.read',
    ],
  },
  SECURITY: {
    name: 'Security',
    description: 'Gate: visitor approvals, check-in and check-out',
    permissions: ['org.read', 'property.read', 'structure.read', 'tenant.read', ...pick('visitor'), 'notice.read'],
  },
  STAFF: {
    name: 'Staff',
    description: 'Housekeeping / maintenance / kitchen — works assigned tasks',
    permissions: [
      'org.read',
      'property.read',
      'structure.read',
      'complaint.read',
      'complaint.update',
      'maintenance.read',
      'maintenance.update',
      'attendance.read',
      'notice.read',
      'mess.read',
      'mess.attendance.mark',
    ],
  },
  TENANT: {
    name: 'Tenant',
    description: 'Resident self-service',
    permissions: [...SELF, 'notice.read', 'mess.read'],
  },
};

// Roles whose data access is limited to records assigned to them.
const ASSIGNMENT_SCOPED_ROLES = ['STAFF'];

// Roles that may be assigned to team members from the app (TENANT is only
// created through the tenant / check-in flow).
const ASSIGNABLE_ROLES = ['OWNER', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'RECEPTIONIST', 'SECURITY', 'STAFF'];

const moduleOf = key => key.split('.')[0];

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS: ALL,
  ROLE_KEYS,
  ROLE_DEFS,
  ASSIGNMENT_SCOPED_ROLES,
  ASSIGNABLE_ROLES,
  moduleOf,
};
