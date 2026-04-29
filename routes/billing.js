const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db/database');
const { requireAuth } = require('./auth');
const { sendEmail } = require('./email');

const BETA_LIMIT = 100;

// — BETA STATUS (public – show on signup page) ————————
router.get('/beta-status', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL').get().count;
  const claimed = Math.min(total, BETA_LIMIT);
  const remaining = Math.max(0, BETA_LIMIT - claimed);
  res.json({
    betaLimit: BETA_LIMIT,
    claimed,
    remaining,
    isFull: remaining === 0,
    message: remaining > 0
      ? `${remaining} free beta spots remaining – no credit card required`
      : 'Beta is full – join the waitlist or start a 14-day free trial'
  });
});

// — PLANS ————————————————————————————
const PLANS = {
  starter: {
    name: 'Starter',
    priceId: process.env.STRIPE_PRICE_STARTER,
    price: 29,
    features: ['50 posts/month', '2 social accounts', 'AI captions', 'Basic scheduling'],
    postsPerMonth: 50,
    accounts: 2
  },
  pro: {
    name: 'Pro',
    priceId: process.env.STRIPE_PRICE_PRO,
    price: 79,
    features: ['Unlimited posts', '10 social accounts', 'AI captions', 'Bulk scheduler', 'Video editor', 'Ad campaigns dashboard'],
    postsPerMonth: -1,
    accounts: 10
  },
  agency: {
    name: 'Agency',
    priceId: process.env.STRIPE_PRICE_AGENCY,
    price: 199,
    features: ['Unlimited posts', 'Unlimited accounts', 'All Pro features', 'White-label', 'Priority support', 'Team members'],
    postsPerMonth: -1,
    accounts: -1
  }
};

// — GET PLANS ————————————————————————
router.get('/plans', (req, res) => {
  res.json({ plans: PLANS });
});

// — GET CURRENT SUBSCRIPTION ————————————————
router.get('/subscription', requireAuth, (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.id);
  if (!sub) return res.json({ subscription: null });

  const plan = PLANS[sub.plan] || PLANS.pro;
  const isBeta = !!sub.is_beta;
  const isTrialActive = sub.status === 'trial' && sub.trial_ends_at > Date.now();
  const trialDaysLeft = isTrialActive ? Math.ceil((sub.trial_ends_at - Date.now()) / 86400000) : 0;

  res.json({
    subscription: {
      ...sub,
      planDetails: plan,
      isBeta,
      betaUserNumber: sub.beta_user_number,
      isTrialActive,
      trialDaysLeft,
      isActive: isBeta || sub.status === 'active' || isTrialActive
    }
  });
});

// — CREATE CHECKOUT SESSION ————————————————
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    // Beta users never pay
    const betaSub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.id);
    if (betaSub?.is_beta) {
      return res.json({
        isBeta: true,
        message: 'You have free Pro access as a beta user – no payment needed!'
      });
    }

    const { planKey } = req.body;
    const plan = PLANS[planKey];
    if (!plan) return res.status(400).json({ error: 'Invalid plan' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const checkoutSub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.id);

    // Get or create Stripe customer
    let stripeCustomerId = checkoutSub?.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: req.user.id }
      });
      stripeCustomerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{ price: plan.priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/settings?checkout=success&plan=${planKey}`,
      cancel_url: `${process.env.FRONTEND_URL}/settings?checkout=cancelled`,
      subscription_data: {
        trial_period_days: checkoutSub?.status === 'trial' ? Math.max(0, Math.ceil((checkoutSub.trial_ends_at - Date.now()) / 86400000)) : 0,
        metadata: { userId: req.user.id, plan: planKey }
      },
      allow_promotion_codes: true
    });

    // Save customer ID if new
    if (!checkoutSub?.stripe_customer_id) {
      if (checkoutSub) {
        db.prepare('UPDATE subscriptions SET stripe_customer_id = ? WHERE user_id = ?').run(stripeCustomerId, req.user.id);
      } else {
        db.prepare('INSERT INTO subscriptions (user_id, plan, status, stripe_customer_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(req.user.id, planKey, 'pending', stripeCustomerId, Date.now());
      }
    }

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// — CUSTOMER PORTAL (manage billing) ————————————
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const sub = db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?').get(req.user.id);
    if (!sub?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found – subscribe first' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/settings`
    });

    res.json({ portalUrl: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
});

// — STRIPE WEBHOOK ————————————————————
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;
        if (!userId) break;

        const plan = subscription.metadata?.plan || getPlanFromPriceId(subscription.items.data[0]?.price?.id);
        const status = subscription.status === 'active' || subscription.status === 'trialing' ? 'active' : subscription.status;

        db.prepare(`
          UPDATE subscriptions SET
            plan = ?,
            status = ?,
            stripe_subscription_id = ?,
            current_period_start = ?,
            current_period_end = ?,
            cancel_at_period_end = ?,
            updated_at = ?
          WHERE user_id = ?
        `).run(
          plan,
          status,
          subscription.id,
          subscription.current_period_start * 1000,
          subscription.current_period_end * 1000,
          subscription.cancel_at_period_end ? 1 : 0,
          Date.now(),
          userId
        );

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (user && event.type === 'customer.subscription.created') {
          await sendEmail({
            to: user.email,
            subject: `You're on Luna X ${PLANS[plan]?.name || plan} – welcome!`,
            html: `
              <h2>Subscription confirmed 🎉</h2>
              <p>Hi ${user.name}, you're now on the <strong>${PLANS[plan]?.name || plan}</strong> plan.</p>
              <p>You have access to all ${PLANS[plan]?.name} features. Head back to Luna X to start posting.</p>
              <a href="${process.env.FRONTEND_URL}" style="display:inline-block;padding:12px 24px;background:#7c6dfa;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Go to Luna X →</a>
            `
          });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const sub = db.prepare('SELECT * FROM subscriptions WHERE stripe_customer_id = ?').get(customerId);
        if (sub) {
          db.prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE user_id = ?')
            .run('active', Date.now(), sub.user_id);
          db.prepare('INSERT INTO payments (user_id, stripe_invoice_id, amount, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(sub.user_id, invoice.id, invoice.amount_paid, invoice.currency, 'succeeded', Date.now());
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const sub = db.prepare('SELECT * FROM subscriptions WHERE stripe_customer_id = ?').get(customerId);
        if (sub) {
          db.prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE user_id = ?')
            .run('past_due', Date.now(), sub.user_id);
          const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.user_id);
          if (user) {
            await sendEmail({
              to: user.email,
              subject: 'Luna X – payment failed, action needed',
              html: `
                <h2>Payment failed</h2>
                <p>Hi ${user.name}, we couldn't process your payment for Luna X.</p>
                <p>Your account is still active, but please update your payment method in the next 7 days to avoid losing access.</p>
                <a href="${process.env.FRONTEND_URL}/settings" style="display:inline-block;padding:12px 24px;background:#7c6dfa;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Update payment →</a>
              `
            });
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;
        if (!userId) break;
        db.prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE user_id = ?')
          .run('cancelled', Date.now(), userId);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (user) {
          await sendEmail({
            to: user.email,
            subject: 'Luna X subscription cancelled',
            html: `
              <h2>Subscription cancelled</h2>
              <p>Hi ${user.name}, your Luna X subscription has been cancelled. You'll keep access until the end of your billing period.</p>
              <p>We'd love to have you back – you can resubscribe anytime.</p>
              <a href="${process.env.FRONTEND_URL}/settings" style="display:inline-block;padding:12px 24px;background:#7c6dfa;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Resubscribe →</a>
            `
          });
        }
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// — CHECK ACCESS (middleware for gating features) ————
function requireActiveSubscription(req, res, next) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.id);
  if (!sub) return res.status(402).json({ error: 'Subscription required', code: 'NO_SUBSCRIPTION' });

  if (sub.is_beta) {
    req.subscription = sub;
    req.plan = PLANS.pro;
    req.isBeta = true;
    return next();
  }

  const isTrialActive = sub.status === 'trial' && sub.trial_ends_at > Date.now();
  const isActive = sub.status === 'active' || isTrialActive;

  if (!isActive) {
    return res.status(402).json({
      error: 'Your subscription is not active',
      code: 'SUBSCRIPTION_INACTIVE',
      status: sub.status
    });
  }

  req.subscription = sub;
  req.plan = PLANS[sub.plan] || PLANS.starter;
  next();
}

function getPlanFromPriceId(priceId) {
  for (const [key, plan] of Object.entries(PLANS)) {
    if (plan.priceId === priceId) return key;
  }
  return 'starter';
}

module.exports = router;
module.exports.requireActiveSubscription = requireActiveSubscription;
module.exports.PLANS = PLANS;
