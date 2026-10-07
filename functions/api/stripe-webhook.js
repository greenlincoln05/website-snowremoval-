// POST /api/stripe-webhook
// Verifies the Stripe signature, then keeps `orders` in sync. Handlers are idempotent
// (they set state rather than increment it) and processed event ids are recorded.
import { json, sb, eq, stripe, verifyStripeSignature, serviceWindow } from '../_lib/util.js';

export async function onRequestPost({ request, env }) {
  const payload = await request.text();
  try {
    await verifyStripeSignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('webhook signature rejected', err.message);
    return json({ error: 'Bad signature.' }, 400);
  }
  const event = JSON.parse(payload);

  try {
    const seen = await sb(env, `stripe_events?id=${eq(event.id)}&select=id`);
    if (seen.length) return json({ received: true, duplicate: true });

    await handle(env, event);

    await sb(env, 'stripe_events', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates',
      body: { id: event.id, type: event.type },
    });
    return json({ received: true });
  } catch (err) {
    console.error('webhook handler failed', event.type, event.id, err);
    return json({ error: 'Handler failed.' }, 500); // non-2xx makes Stripe retry
  }
}

const setBySubscription = (env, subId, body) =>
  sb(env, `orders?stripe_subscription_id=${eq(subId)}`, { method: 'PATCH', body });

async function handle(env, event) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const orderId = obj.client_reference_id || obj.metadata?.order_id;
      if (!orderId) return;
      // Async payment methods can complete before funds arrive; only mark paid when paid.
      if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') return;
      const plan = obj.metadata?.plan;
      const win = serviceWindow(plan);
      await sb(env, `orders?id=${eq(orderId)}`, {
        method: 'PATCH',
        body: {
          status: plan === 'one_time' ? 'paid' : 'active',
          amount_cents: obj.amount_total,
          stripe_subscription_id: obj.subscription || null,
          stripe_payment_intent_id: obj.payment_intent || null,
          service_start: win?.service_start ?? null,
          service_end: win?.service_end ?? null,
        },
      });
      if (obj.customer && obj.metadata?.customer_id) {
        await sb(env, `customers?id=${eq(obj.metadata.customer_id)}`, {
          method: 'PATCH',
          body: { stripe_customer_id: obj.customer },
        });
      }
      // Monthly plan ends after March 31: schedule the cancellation on the subscription.
      if (plan === 'monthly' && obj.subscription && win) {
        await stripe(env, `subscriptions/${obj.subscription}`, { cancel_at: win.cancel_at });
      }
      return;
    }
    case 'checkout.session.expired': {
      const orderId = obj.client_reference_id || obj.metadata?.order_id;
      if (orderId) await sb(env, `orders?id=${eq(orderId)}&status=eq.pending`, { method: 'PATCH', body: { status: 'canceled' } });
      return;
    }
    case 'invoice.paid': {
      const subId = obj.subscription || obj.parent?.subscription_details?.subscription;
      if (subId) await sb(env, `orders?stripe_subscription_id=${eq(subId)}&status=eq.past_due`, { method: 'PATCH', body: { status: 'active' } });
      return;
    }
    case 'invoice.payment_failed': {
      const subId = obj.subscription || obj.parent?.subscription_details?.subscription;
      if (subId) await setBySubscription(env, subId, { status: 'past_due' });
      return;
    }
    case 'customer.subscription.updated': {
      // Never resurrect a canceled order from a stale update event.
      const map = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due' };
      const status = map[obj.status];
      if (status) await sb(env, `orders?stripe_subscription_id=${eq(obj.id)}&status=neq.canceled`, { method: 'PATCH', body: { status } });
      return;
    }
    case 'customer.subscription.deleted':
      await setBySubscription(env, obj.id, { status: 'canceled' });
      return;
    default:
      return; // other events are ignored (still recorded as processed)
  }
}
