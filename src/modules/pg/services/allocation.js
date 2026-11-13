const Bed = require('../models/Bed');
const BedAllocation = require('../models/BedAllocation');
const errors = require('../../core/errors');

// Double allocation is impossible by construction:
//   1. claimBed() is a single conditional findOneAndUpdate — of N concurrent
//      claims on an AVAILABLE bed exactly one matches, the rest get null.
//   2. BedAllocation has partial unique indexes (one ACTIVE per bed and per
//      tenant), so even a bug elsewhere cannot persist a second occupant.

/** Atomically move a bed to OCCUPIED for `tenantId`. */
const claimBed = async (organizationId, bedId, tenantId, session = null) => {
  const now = new Date();
  const bed = await Bed.findOneAndUpdate(
    {
      _id: bedId,
      organizationId,
      $or: [
        { status: 'AVAILABLE' },
        { status: 'RESERVED', reservedForTenantId: tenantId },
        { status: 'RESERVED', reservedUntil: { $lt: now } },
      ],
    },
    {
      $set: {
        status: 'OCCUPIED',
        currentTenantId: tenantId,
        reservedForTenantId: null,
        reservedUntil: null,
        statusChangedAt: now,
        statusNote: '',
      },
    },
    { new: true, session: session || undefined },
  );
  if (!bed) {
    throw errors.conflict('This bed is not available any more. Please pick another bed.', 'BED_NOT_AVAILABLE');
  }
  return bed;
};

/** Open an ACTIVE allocation (occupancy history row) and link the bed. */
const openAllocation = async ({ organizationId, bed, tenantId, startDate, monthlyRent, checkInId = null }, session = null) => {
  let allocation;
  try {
    [allocation] = await BedAllocation.create(
      [
        {
          organizationId,
          propertyId: bed.propertyId,
          roomId: bed.roomId,
          bedId: bed._id,
          tenantId,
          startDate,
          monthlyRent,
          checkInId,
        },
      ],
      { session: session || undefined },
    );
  } catch (e) {
    if (e && e.code === 11000) {
      throw errors.conflict('This bed or tenant already has an active allocation.', 'DOUBLE_ALLOCATION');
    }
    throw e;
  }
  await Bed.updateOne(
    { _id: bed._id, organizationId, currentTenantId: tenantId },
    { $set: { currentAllocationId: allocation._id } },
    { session: session || undefined },
  );
  return allocation;
};

/** Close an allocation and free its bed. */
const closeAllocation = async ({ organizationId, allocationId, tenantId, endDate, reason, checkOutId = null }, session = null) => {
  const allocation = await BedAllocation.findOneAndUpdate(
    { _id: allocationId, organizationId, status: 'ACTIVE' },
    { $set: { status: 'ENDED', endDate, endReason: reason, checkOutId } },
    { new: true, session: session || undefined },
  );
  if (!allocation) throw errors.conflict('This stay is already closed.', 'ALLOCATION_CLOSED');
  await Bed.updateOne(
    { _id: allocation.bedId, organizationId, currentTenantId: tenantId },
    {
      $set: {
        status: 'AVAILABLE',
        currentTenantId: null,
        currentAllocationId: null,
        statusChangedAt: new Date(),
      },
    },
    { session: session || undefined },
  );
  return allocation;
};

module.exports = { claimBed, openAllocation, closeAllocation };
