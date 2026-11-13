/**
 * PG / Hostel SaaS demo data.
 *
 *   npm run seed:pg              create demo data (refuses if it already exists)
 *   npm run seed:pg -- --reset   wipe ONLY the demo organizations / users, then re-create
 *
 * Creates: 1 super admin, 2 owner organizations (multi-tenancy testing),
 * properties → buildings → floors → rooms → beds, a team per org, tenants
 * (checked in, on notice, prospects), back-dated rent invoices, payments,
 * complaints, maintenance, expenses, visitors, notices and a mess menu.
 *
 * Runs through the real services (check-in, payments, invoice generation),
 * so the demo data obeys every business rule. Never runs in production
 * unless --force is passed.
 */
const mongoose = require('mongoose');
const env = require('../config/env');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const { seedRbac, permissionsFor } = require('../modules/saas/services/rbac');
const { seedPlans } = require('../modules/saas/services/plans');
const { detectTransactionSupport } = require('../modules/core/tx');
const { createOrganization } = require('../modules/saas/services/organizations');
const { activatePlan } = require('../modules/saas/services/subscriptions');
const { findOrCreateUserByPhone, ensureMembership } = require('../modules/pg/services/accounts');
const { createBeds } = require('../modules/pg/services/structure');
const { checkIn } = require('../modules/pg/services/checkin');
const { recordOfflinePayment } = require('../modules/pg/services/payments');
const { generateDueInvoices, refreshOverdue } = require('../modules/pg/services/invoices');
const { passCode } = require('../modules/pg/services/visitors');
const { nextNumber } = require('../modules/core/counters');
const { unscoped } = require('../modules/core/scope');
const D = require('../modules/core/dates');

const Organization = require('../modules/saas/models/Organization');
const OrganizationUser = require('../modules/saas/models/OrganizationUser');
const PgProperty = require('../modules/pg/models/PgProperty');
const Building = require('../modules/pg/models/Building');
const Floor = require('../modules/pg/models/Floor');
const Room = require('../modules/pg/models/Room');
const Tenant = require('../modules/pg/models/Tenant');
const Staff = require('../modules/pg/models/Staff');
const Complaint = require('../modules/pg/models/Complaint');
const MaintenanceTask = require('../modules/pg/models/MaintenanceTask');
const Expense = require('../modules/pg/models/Expense');
const ExpenseCategory = require('../modules/pg/models/ExpenseCategory');
const Visitor = require('../modules/pg/models/Visitor');
const Notice = require('../modules/pg/models/Notice');
const MessMenu = require('../modules/pg/models/MessMenu');
const Amenity = require('../modules/pg/models/Amenity');
const Bed = require('../modules/pg/models/Bed');

const args = new Set(process.argv.slice(2));
const PASSWORD = process.env.SEED_PASSWORD || 'Abroo@12345';

const DEMO = {
  superAdmin: { fullName: 'Aabroo Platform Admin', email: 'superadmin@abroo.dev', phone: '9000000001' },
  orgs: [
    {
      name: 'Sunrise Residency PG',
      city: 'Bengaluru',
      state: 'Karnataka',
      owner: { fullName: 'Ananya Rao', email: 'owner.sunrise@abroo.dev', phone: '9000000101' },
      team: [
        ['PROPERTY_MANAGER', 'Vikram Shetty', '9000000102'],
        ['ACCOUNTANT', 'Deepa Kulkarni', '9000000103'],
        ['RECEPTIONIST', 'Farah Khan', '9000000104'],
        ['SECURITY', 'Ramesh Gowda', '9000000105'],
      ],
      staff: [
        ['Manju Electrician', '9000000106', 'ELECTRICIAN', 'MAINTENANCE', 'STAFF'],
        ['Lakshmi Housekeeping', '9000000107', 'CLEANER', 'HOUSEKEEPING', null],
        ['Chef Arun', '9000000108', 'COOK', 'KITCHEN', null],
      ],
      properties: [
        { name: 'Sunrise Koramangala', locality: 'Koramangala 5th Block', pincode: '560095', gender: 'UNISEX', mess: 3500, floors: 3, roomsPerFloor: 4 },
        { name: 'Sunrise HSR Layout', locality: 'HSR Layout Sector 2', pincode: '560102', gender: 'FEMALE', mess: 3200, floors: 2, roomsPerFloor: 3 },
      ],
      tenants: 14,
    },
    {
      name: 'GreenNest Hostels',
      city: 'Pune',
      state: 'Maharashtra',
      owner: { fullName: 'Rohit Deshmukh', email: 'owner.greennest@abroo.dev', phone: '9000000201' },
      team: [
        ['PROPERTY_MANAGER', 'Sneha Patil', '9000000202'],
        ['SECURITY', 'Ganesh More', '9000000203'],
      ],
      staff: [['Sachin Plumber', '9000000204', 'PLUMBER', 'MAINTENANCE', 'STAFF']],
      properties: [
        { name: 'GreenNest Viman Nagar', locality: 'Viman Nagar', pincode: '411014', gender: 'MALE', mess: 3000, floors: 2, roomsPerFloor: 4 },
        { name: 'GreenNest Kothrud', locality: 'Kothrud', pincode: '411038', gender: 'UNISEX', mess: 0, floors: 1, roomsPerFloor: 4 },
      ],
      tenants: 9,
    },
  ],
};

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Isha', 'Arjun', 'Meera', 'Rohan', 'Sara', 'Vihaan', 'Anika', 'Aditya', 'Kiara', 'Reyansh', 'Myra', 'Karthik', 'Nisha', 'Siddharth', 'Pooja', 'Yash', 'Tanvi', 'Neel', 'Riya', 'Omkar'];
const LAST = ['Sharma', 'Iyer', 'Menon', 'Reddy', 'Nair', 'Patel', 'Joshi', 'Gupta', 'Das', 'Kapoor', 'Bose', 'Pillai'];
const ROOM_TYPES = ['SINGLE', 'DOUBLE', 'TRIPLE', 'FOUR_SHARING'];
const RENT = { SINGLE: 14000, DOUBLE: 10000, TRIPLE: 8500, FOUR_SHARING: 7000 };

const log = (...a) => console.log('[seed:pg]', ...a);

// Every demo phone number lives in the reserved 9000xxxxxx range so that
// --reset can remove demo logins without ever touching real accounts.
const demoPhone = (kind, orgIndex, i) => `9000${kind}${orgIndex}${String(i).padStart(4, '0')}`;
const DEMO_PHONE_RE = /^9000\d{6}$/;

/** A request-shaped context so seeding runs through the real services. */
const actingAs = async (user, orgId) => {
  const org = await Organization.findById(orgId).lean();
  const membership = await OrganizationUser.findOne({ organizationId: orgId, userId: user._id }).lean();
  return {
    user,
    ip: '127.0.0.1',
    requestId: 'seed',
    get: () => '',
    auth: { isSuperAdmin: false },
    ctx: { orgId, org, membership, role: membership.role, permissions: await permissionsFor(membership), propertyIds: null },
  };
};

const upsertUser = async ({ fullName, email, phone }, role = 'consumer') => {
  let user = await User.findOne({ email });
  if (!user) user = new User({ fullName, email, phone, role });
  user.fullName = fullName;
  user.phone = phone;
  user.role = role;
  await user.setPassword(PASSWORD);
  await user.save();
  return user;
};

const demoEmails = () => [DEMO.superAdmin.email, ...DEMO.orgs.map(o => o.owner.email)];
const demoPhones = () => DEMO.orgs.flatMap(o => [...o.team.map(t => t[2]), ...o.staff.map(s => s[1])]);

const reset = async () => {
  const owners = await User.find({ email: { $in: demoEmails() } }).select('_id').lean();
  const orgIds = (await Organization.find({ ownerUserId: { $in: owners.map(o => o._id) } }).select('_id').lean()).map(o => o._id);
  const db = mongoose.connection.db;
  const collections = (await db.listCollections().toArray()).map(c => c.name);
  for (const name of collections) {
    if (!/^(pg_|saas_)/.test(name) || ['saas_plans', 'saas_roles', 'saas_permissions', 'saas_platform_settings', 'saas_coupons', 'saas_feature_flags'].includes(name)) continue;
    await db.collection(name).deleteMany({ organizationId: { $in: orgIds } });
  }
  await db.collection('saas_organizations').deleteMany({ _id: { $in: orgIds } });
  await db.collection('saas_counters').deleteMany({ _id: { $regex: `^(${orgIds.join('|') || 'none'}):` } });
  await db.collection('audit_logs').deleteMany({ organizationId: { $in: orgIds } });
  await db.collection('notifications').deleteMany({ organizationId: { $in: orgIds } });
  // Resident / staff logins created by the demo (phone-based placeholder accounts).
  await User.deleteMany({ $or: [{ email: { $in: demoEmails() } }, { phone: { $in: demoPhones() } }, { phone: DEMO_PHONE_RE }] });
  log(`reset: removed ${orgIds.length} demo organization(s)`);
};

const seedOrg = async (spec, orgIndex) => {
  const owner = await upsertUser(spec.owner);
  const { organization } = await createOrganization(owner, { name: spec.name, city: spec.city, state: spec.state, phone: spec.owner.phone });
  const orgId = organization.id;
  // First org: paying Business customer. Second org: stays on its trial.
  if (orgIndex === 0) await unscoped(() => activatePlan(orgId, { planCode: 'BUSINESS', billingCycle: 'MONTHLY', note: 'Seed data' }));
  await Organization.updateOne(
    { _id: orgId },
    { $set: { 'settings.lateFee': { type: 'PER_DAY', amount: 50, graceDays: 3, maxAmount: 1000 }, gstin: orgIndex === 0 ? '29ABCDE1234F1Z5' : '' } },
  );
  const req = await actingAs(owner, orgId);
  const amenities = await Amenity.find({ organizationId: orgId }).lean();
  const amenity = name => amenities.find(a => a.name === name)._id;

  // ---- Structure -------------------------------------------------------------------
  const allBeds = [];
  const properties = [];
  for (const [pi, p] of spec.properties.entries()) {
    const property = await PgProperty.create({
      organizationId: orgId,
      name: p.name,
      code: p.name.split(' ').map(w => w[0]).join('').slice(0, 4).toUpperCase(),
      description: `${p.name} — fully furnished ${p.gender === 'FEMALE' ? 'women’s' : p.gender === 'MALE' ? 'men’s' : 'co-living'} PG with meals, Wi-Fi and housekeeping.`,
      propertyType: pi === 1 && orgIndex === 1 ? 'HOSTEL' : 'PG',
      genderType: p.gender,
      address: { line1: `${12 + pi * 7}, ${p.locality}`, locality: p.locality, city: spec.city, state: spec.state, pincode: p.pincode },
      amenityIds: ['Wi-Fi', 'Power backup', 'Housekeeping', 'CCTV', '24x7 Security', 'Laundry', ...(p.mess ? ['Meals'] : [])].map(amenity),
      rules: ['Gate closes at 11:00 PM', 'No smoking inside the premises', 'Visitors allowed till 8:00 PM with a pass', 'Keep common areas clean'],
      photos: [{ url: `https://images.unsplash.com/photo-${pi === 0 ? '1555854877-bab0e564b8d5' : '1522708323590-d24dbb6b0267'}?auto=format&fit=crop&w=1200&q=70` }],
      contact: { name: spec.owner.fullName, phone: spec.owner.phone, email: spec.owner.email, whatsapp: spec.owner.phone },
      messEnabled: p.mess > 0,
      messChargeMonthly: p.mess,
      foodType: 'BOTH',
    });
    properties.push(property);
    const building = await Building.create({ organizationId: orgId, propertyId: property._id, name: 'Main Block', code: 'MB' });
    for (let f = 0; f < p.floors; f += 1) {
      const floor = await Floor.create({ organizationId: orgId, propertyId: property._id, buildingId: building._id, name: f === 0 ? 'Ground Floor' : `Floor ${f}`, level: f });
      for (let r = 0; r < p.roomsPerFloor; r += 1) {
        const roomType = ROOM_TYPES[(r + f) % ROOM_TYPES.length];
        const room = await Room.create({
          organizationId: orgId,
          propertyId: property._id,
          buildingId: building._id,
          floorId: floor._id,
          roomNumber: `${f + 1}${String(r + 1).padStart(2, '0')}`,
          roomType,
          capacity: { SINGLE: 1, DOUBLE: 2, TRIPLE: 3, FOUR_SHARING: 4 }[roomType],
          rentPerBed: RENT[roomType] - orgIndex * 1000,
          depositPerBed: (RENT[roomType] - orgIndex * 1000) * 2,
          amenityIds: [amenity('Wardrobe'), amenity('Study table'), ...(roomType === 'SINGLE' ? [amenity('Air conditioning'), amenity('Attached bathroom')] : [])],
          attributes: { ac: roomType === 'SINGLE', attachedBathroom: roomType !== 'FOUR_SHARING', balcony: r === 0, furnished: true },
        });
        const beds = await createBeds(room, room.capacity);
        allBeds.push(...beds.map(b => ({ bed: b, property })));
      }
    }
  }
  // One bed under maintenance, one blocked.
  if (allBeds.length > 4) {
    for (const [x, status, note] of [
      [allBeds[allBeds.length - 1], 'MAINTENANCE', 'Mattress replacement'],
      [allBeds[allBeds.length - 2], 'BLOCKED', 'Reserved for staff'],
    ]) {
      await Bed.updateOne({ organizationId: orgId, _id: x.bed._id }, { $set: { status, statusNote: note } });
      x.bed.status = status;
    }
  }
  log(`${spec.name}: ${properties.length} properties, ${allBeds.length} beds`);

  // ---- Team & staff ------------------------------------------------------------------
  for (const [role, fullName, phone] of spec.team) {
    const user = await findOrCreateUserByPhone({ phone, fullName });
    await user.setPassword(PASSWORD);
    await user.save();
    await ensureMembership({ organizationId: orgId, userId: user._id, role, displayName: fullName, phone, invitedBy: owner._id });
  }
  const staffRows = [];
  for (const [fullName, phone, jobRole, department, appRole] of spec.staff) {
    const staff = await Staff.create({ organizationId: orgId, fullName, phone, jobRole, department, propertyIds: [], salary: 18000, joinedAt: D.addMonths(D.todayIn(), -8) });
    if (appRole) {
      const user = await findOrCreateUserByPhone({ phone, fullName });
      await user.setPassword(PASSWORD);
      await user.save();
      const { membership } = await ensureMembership({ organizationId: orgId, userId: user._id, role: appRole, staffId: staff._id, displayName: fullName, phone });
      staff.userId = user._id;
      staff.membershipId = membership._id;
      await staff.save();
    }
    staffRows.push(staff);
  }

  // ---- Tenants: check-ins spread over the last 4 months -------------------------------
  const today = D.todayIn();
  const freeBeds = allBeds.filter(x => x.bed.status === 'AVAILABLE');
  const tenants = [];
  for (let i = 0; i < spec.tenants && i < freeBeds.length; i += 1) {
    const name = `${FIRST[(i + orgIndex * 5) % FIRST.length]} ${LAST[(i * 3 + orgIndex) % LAST.length]}`;
    const phone = demoPhone(1, orgIndex, i);
    const tenant = await Tenant.create({
      organizationId: orgId,
      fullName: name,
      phone,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      gender: i % 2 ? 'FEMALE' : 'MALE',
      occupation: i % 3 ? 'Software Engineer' : 'Student',
      organizationName: i % 3 ? 'Tech Corp' : 'City College',
      foodPreference: ['VEG', 'NON_VEG', 'EGGETARIAN'][i % 3],
      messOptIn: freeBeds[i].property.messEnabled && i % 4 !== 0,
      emergencyContacts: [{ name: `${LAST[i % LAST.length]} Senior`, relation: 'Parent', phone: demoPhone(4, orgIndex, i) }],
      source: ['WALK_IN', 'REFERRAL', 'ONLINE'][i % 3],
    });
    const joined = D.addDays(today, -(15 + ((i * 11) % 110)));
    const deposit = i % 5 === 0 ? 0 : undefined;
    await checkIn(req, {
      tenantId: tenant._id,
      bedId: freeBeds[i].bed._id,
      checkInDate: D.dayKey(joined),
      ...(deposit === 0 ? { depositAmount: 0 } : {}),
      agreement: { lockInMonths: 3, noticePeriodDays: 30 },
      collect: i % 4 === 3 ? undefined : { amount: (freeBeds[i].bed.deposit ?? 0) || (RENT.DOUBLE - orgIndex * 1000) * 2, method: i % 2 ? 'UPI' : 'CASH', reference: i % 2 ? `UPI${1000 + i}` : '' },
    });
    tenants.push(tenant);
  }
  // A few prospects (enquired, not yet checked in).
  for (let i = 0; i < 3; i += 1) {
    await Tenant.create({ organizationId: orgId, fullName: `${FIRST[(i + 17) % FIRST.length]} Prospect`, phone: demoPhone(2, orgIndex, i), source: 'ONLINE' });
  }

  // Back-bill missed months, mark overdue, then collect most of it.
  await generateDueInvoices(orgId);
  await refreshOverdue(orgId);
  for (const [i, t] of tenants.entries()) {
    if (i % 4 === 1) continue; // leave some dues outstanding
    const Invoice = require('../modules/pg/models/RentInvoice');
    const open = await Invoice.find({ organizationId: orgId, tenantId: t._id, status: { $in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] } }).lean();
    const due = open.reduce((s, x) => s + x.balance, 0);
    if (due > 0) {
      await recordOfflinePayment(req, {
        tenantId: t._id,
        amount: i % 6 === 0 ? Math.round(due / 2) : due + (i % 7 === 0 ? 2000 : 0),
        method: ['UPI', 'CASH', 'BANK_TRANSFER', 'CARD'][i % 4],
        reference: `SEED-${i}`,
        idempotencyKey: `seed-${orgId}-${i}`,
      });
    }
  }
  // Notice given by one tenant.
  if (tenants[2]) {
    await Tenant.updateOne({ organizationId: orgId, _id: tenants[2]._id }, { $set: { status: 'NOTICE', noticeGivenAt: D.addDays(today, -10), expectedCheckoutDate: D.addDays(today, 20) } });
  }

  // ---- Operations ---------------------------------------------------------------------
  const categories = await ExpenseCategory.find({ organizationId: orgId }).lean();
  const cat = code => categories.find(c => c.code === code);
  for (let m = 0; m < 4; m += 1) {
    const monthDay = D.addMonths(D.startOfMonth(today), -m);
    for (const [code, amount] of [['ELECTRICITY', 18500], ['WATER', 4200], ['SALARY', 52000], ['FOOD', 61000], ['INTERNET', 3500], ['CLEANING', 6000]]) {
      const c = cat(code);
      await Expense.create({
        organizationId: orgId,
        propertyId: properties[m % properties.length]._id,
        categoryId: c._id,
        categoryName: c.name,
        categoryCode: c.code,
        amount: amount - orgIndex * 3000 + m * 250,
        date: D.addDays(monthDay, 4),
        vendor: { ELECTRICITY: 'BESCOM', WATER: 'Water Board', SALARY: 'Payroll', FOOD: 'Fresh Mart', INTERNET: 'ACT Fibernet', CLEANING: 'CleanCo' }[code],
        paymentMethod: code === 'SALARY' ? 'BANK_TRANSFER' : 'UPI',
      });
    }
  }
  const complaints = [
    ['WIFI', 'Wi-Fi keeps disconnecting', 'HIGH', 'OPEN'],
    ['PLUMBING', 'Leaking tap in bathroom', 'MEDIUM', 'ASSIGNED'],
    ['ELECTRICITY', 'Tube light not working', 'LOW', 'IN_PROGRESS'],
    ['CLEANING', 'Room not cleaned on Tuesday', 'LOW', 'RESOLVED'],
    ['AC', 'AC making noise', 'MEDIUM', 'CLOSED'],
  ];
  for (const [i, [category, title, priority, status]] of complaints.entries()) {
    const t = tenants[i];
    if (!t) break;
    const fresh = await Tenant.findOne({ organizationId: orgId, _id: t._id }).lean();
    const assigned = status !== 'OPEN' ? staffRows[0] : null;
    const history = [{ status: 'OPEN', byName: fresh.fullName, note: 'Raised from the app' }];
    for (const s of ['ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']) {
      history.push({ status: s, byName: s === 'ASSIGNED' ? spec.owner.fullName : assigned ? assigned.fullName : '', note: '' });
      if (s === status) break;
    }
    await Complaint.create({
      organizationId: orgId,
      complaintNumber: await nextNumber(orgId, 'CMP', 'CMP'),
      tenantId: t._id,
      propertyId: fresh.current.propertyId,
      roomId: fresh.current.roomId,
      category,
      title,
      description: `${title}. Please look into it.`,
      priority,
      status,
      assignedToStaffId: assigned ? assigned._id : null,
      assignedAt: assigned ? new Date() : null,
      resolvedAt: ['RESOLVED', 'CLOSED'].includes(status) ? new Date() : null,
      closedAt: status === 'CLOSED' ? new Date() : null,
      raisedByUserId: fresh.userId,
      raisedByRole: 'TENANT',
      rating: status === 'CLOSED' ? 4 : null,
      history,
    });
  }
  await MaintenanceTask.create({
    organizationId: orgId,
    taskNumber: await nextNumber(orgId, 'MNT', 'MNT'),
    title: 'Quarterly water tank cleaning',
    category: 'CLEANING',
    propertyId: properties[0]._id,
    priority: 'MEDIUM',
    status: 'ASSIGNED',
    assignedToStaffId: staffRows[0]._id,
    assignedAt: new Date(),
    dueDate: D.addDays(today, 5),
    estimatedCost: 3500,
    history: [{ status: 'CREATED', byName: spec.owner.fullName }, { status: 'ASSIGNED', byName: spec.owner.fullName }],
  });
  for (const [i, t] of tenants.slice(0, 3).entries()) {
    const fresh = await Tenant.findOne({ organizationId: orgId, _id: t._id }).lean();
    await Visitor.create({
      organizationId: orgId,
      passCode: passCode(),
      tenantId: t._id,
      propertyId: fresh.current.propertyId,
      visitorName: ['Parents', 'College friend', 'Courier'][i],
      visitorPhone: demoPhone(3, orgIndex, i),
      purpose: ['Family visit', 'Study group', 'Delivery'][i],
      expectedAt: new Date(Date.now() + (i - 1) * 3600 * 1000),
      validUntil: new Date(Date.now() + 12 * 3600 * 1000),
      status: ['REQUESTED', 'APPROVED', 'CHECKED_IN'][i],
      requestedByUserId: fresh.userId,
      requestedByRole: 'TENANT',
      checkedInAt: i === 2 ? new Date() : null,
    });
  }
  const current = await Tenant.find({ organizationId: orgId, status: { $in: ['ACTIVE', 'NOTICE'] } }).select('_id').lean();
  await Notice.create({
    organizationId: orgId,
    title: 'Monthly maintenance on Sunday',
    body: 'Water supply will be off from 10 AM to 1 PM this Sunday for tank cleaning. Please store water in advance.',
    category: 'MAINTENANCE',
    priority: 'IMPORTANT',
    audience: { type: 'ALL' },
    recipientTenantIds: current.map(t => t._id),
    recipientCount: current.length,
    pinned: true,
    createdBy: owner._id,
  });
  const menu = [
    [['Idli', 'Sambar', 'Chutney'], ['Rice', 'Dal', 'Aloo sabzi', 'Curd'], ['Chapati', 'Paneer butter masala', 'Salad']],
    [['Poha', 'Tea'], ['Rajma', 'Jeera rice', 'Salad'], ['Chapati', 'Mix veg', 'Dal tadka']],
    [['Upma', 'Coffee'], ['Veg biryani', 'Raita'], ['Chapati', 'Chole', 'Rice']],
    [['Aloo paratha', 'Curd'], ['Rice', 'Sambar', 'Beans poriyal'], ['Chapati', 'Egg curry / Paneer', 'Rice']],
    [['Dosa', 'Chutney'], ['Rice', 'Dal fry', 'Cabbage sabzi'], ['Pulao', 'Kadhi']],
    [['Bread omelette / Bread jam', 'Tea'], ['Chicken curry / Veg kurma', 'Rice'], ['Chapati', 'Dal makhani']],
    [['Puri bhaji'], ['Special thali'], ['Fried rice', 'Manchurian']],
  ];
  for (const p of properties.filter(x => x.messEnabled)) {
    for (let d = 0; d < 7; d += 1) {
      await MessMenu.create({
        organizationId: orgId,
        propertyId: p._id,
        dayOfWeek: d,
        breakfast: { items: menu[d][0], time: '08:00' },
        lunch: { items: menu[d][1], time: '13:00' },
        dinner: { items: menu[d][2], time: '20:30' },
      });
    }
  }
  log(`${spec.name}: ${tenants.length} tenants checked in, team of ${spec.team.length + spec.staff.length}`);
  return orgId;
};

const main = async () => {
  if (env.IS_PROD && !args.has('--force')) {
    console.error('[seed:pg] Refusing to seed demo data into production (pass --force to override).');
    process.exit(1);
  }
  await connectDB();
  await seedRbac();
  await seedPlans();
  await detectTransactionSupport();

  if (args.has('--reset')) await reset();
  else if (await User.exists({ email: DEMO.orgs[0].owner.email })) {
    log('Demo data already exists. Re-run with --reset to recreate it.');
    await mongoose.connection.close();
    return;
  }

  await upsertUser(DEMO.superAdmin, 'admin');
  for (const [i, spec] of DEMO.orgs.entries()) await seedOrg(spec, i);

  log('done ✓');
  log('');
  log(`Password for every demo login: ${PASSWORD}`);
  log(`Super admin : ${DEMO.superAdmin.email}`);
  for (const o of DEMO.orgs) {
    log(`${o.name}`);
    log(`  Owner     : ${o.owner.email}  (phone ${o.owner.phone})`);
    for (const [role, name, phone] of o.team) log(`  ${role.padEnd(16)}: ${name} — phone ${phone}`);
  }
  log(`Residents sign in with OTP using their phone number${env.OTP_MODE === 'fixed' ? ` (OTP ${env.OTP_FIXED_CODE})` : ''}.`);
  await require('../modules/notifications/dispatcher').flush();
  await mongoose.connection.close();
};

main().catch(async e => {
  console.error('[seed:pg] failed', e);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
