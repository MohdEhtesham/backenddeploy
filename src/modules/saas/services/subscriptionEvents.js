const { notify } = require('../../notifications/dispatcher');
const { memberUserIds } = require('./members');

const MESSAGES = {
  trial_expired: ['Your free trial has ended', 'Choose a plan to keep managing your PG. Your data is safe and viewable.'],
  trial_downgraded: ['Trial ended — you are on the Free plan', 'Upgrade any time to unlock more properties and features.'],
  past_due: ['Subscription payment due', 'Your plan period has ended. Renew now to avoid interruption.'],
  expired: ['Subscription expired', 'Your organization is now read-only. Renew your plan to continue.'],
  cancelled: ['Subscription cancelled', 'Your plan has ended as requested. Choose a plan to reactivate.'],
};

/** Notify owners about lifecycle transitions (fire-and-forget). */
const onTransition = (organizationId, _before, _after, events) => {
  const last = events[events.length - 1];
  const msg = MESSAGES[last];
  if (!msg) return;
  memberUserIds(organizationId, ['OWNER'])
    .then(userIds =>
      notify({
        userIds,
        organizationId,
        type: 'subscription',
        title: msg[0],
        body: msg[1],
        data: { route: 'subscription' },
        channels: ['inapp', 'push', 'email'],
      }),
    )
    .catch(e => console.warn('[subscription] notify failed', e.message));
};

module.exports = { onTransition };
