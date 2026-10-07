// POST /api/checkout
// Validates the signup, saves customer + property + a pending order in Supabase,
// creates an embedded Stripe Checkout Session, and returns its client secret.
import { json, validateSignup, sb, eq, stripe } from '../_lib/util.js';

const PRICE_ENV = { one_time: 'STRIPE_PRICE_ONE_TIME', monthly: 'STRIPE_PRICE_MONTHLY', season: 'STRIPE_PRICE_SEASON' };

export async function onRequestPost({ request, env }) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  // Honeypot: real visitors never fill this field.
  if (input && input._gotcha) return json({ error: 'Invalid request.' }, 400);

  const parsed = validateSignup(input || {});
  if (parsed.errors) return json({ error: 'Please fix the highlighted fields.', fields: parsed.errors }, 400);
  const v = parsed.value;

  const priceId = env[PRICE_ENV[v.plan]];
  if (!priceId) return json({ error: 'This plan is not available online right now.' }, 503);

  try {
    // Customer: one row per email.
    let customer = (await sb(env, `customers?email=${eq(v.email)}&limit=1`))[0];
    if (customer) {
      await sb(env, `customers?id=${eq(customer.id)}`, {
        method: 'PATCH',
        body: { name: v.name, phone: v.phone, sms_consent: customer.sms_consent || v.sms_consent },
      });
    } else {
      customer = (await sb(env, 'customers', {
        method: 'POST',
        prefer: 'return=representation',
        body: { name: v.name, phone: v.phone, email: v.email, sms_consent: v.sms_consent },
      }))[0];
    }

    // Property: reuse the same customer's row for the same street address + ZIP.
    let property = (await sb(env,
      `properties?customer_id=${eq(customer.id)}&address_line1=${eq(v.address_line1)}&zip=${eq(v.zip)}&limit=1`))[0];
    const propertyFields = {
      address_line2: v.address_line2 || null, city: v.city, state: v.state,
      driveway_size: v.driveway_size, property_type: v.property_type,
      also_clear: v.also_clear, notes: v.notes || null,
    };
    if (property) {
      await sb(env, `properties?id=${eq(property.id)}`, { method: 'PATCH', body: propertyFields });
    } else {
      property = (await sb(env, 'properties', {
        method: 'POST',
        prefer: 'return=representation',
        body: { customer_id: customer.id, address_line1: v.address_line1, zip: v.zip, ...propertyFields },
      }))[0];
    }

    // Do not bill the same address twice for a recurring plan.
    if (v.plan !== 'one_time') {
      const existing = await sb(env,
        `orders?property_id=${eq(property.id)}&plan=in.(monthly,season)&status=in.(paid,active,past_due)&limit=1`);
      if (existing.length) {
        return json({ error: 'This address already has an active plan. Call or text 518-248-2142 to make changes.' }, 409);
      }
    }

    const order = (await sb(env, 'orders', {
      method: 'POST',
      prefer: 'return=representation',
      body: { customer_id: customer.id, property_id: property.id, plan: v.plan, status: 'pending' },
    }))[0];

    const meta = { order_id: order.id, customer_id: customer.id, property_id: property.id, plan: v.plan };
    const origin = env.SITE_URL || new URL(request.url).origin;
    const isSub = v.plan === 'monthly';
    const session = await stripe(env, 'checkout/sessions', {
      ui_mode: 'embedded',
      mode: isSub ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: v.email,
      customer_creation: isSub ? undefined : 'always',
      client_reference_id: order.id,
      metadata: meta,
      ...(isSub ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
      return_url: `${origin}/signup?session_id={CHECKOUT_SESSION_ID}`,
    });

    await sb(env, `orders?id=${eq(order.id)}`, { method: 'PATCH', body: { stripe_checkout_session_id: session.id } });

    return json({ clientSecret: session.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY });
  } catch (err) {
    console.error('checkout failed', err);
    return json({ error: 'Something went wrong on our end. Please try again or call 518-248-2142.' }, 500);
  }
}
