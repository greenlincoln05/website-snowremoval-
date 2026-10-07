import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { onRequestPost as checkout } from '../functions/api/checkout.js';
import { onRequestPost as webhook } from '../functions/api/stripe-webhook.js';
import { onRequestPost as quote } from '../functions/api/quote.js';

const env = {
  SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PUBLISHABLE_KEY: 'pk_test', STRIPE_WEBHOOK_SECRET: 'whsec', STRIPE_PRICE_MONTHLY: 'price_m',
  STRIPE_PRICE_ONE_TIME: 'price_o', STRIPE_PRICE_SEASON: 'price_s',
};
const signup = {
  plan: 'monthly', name: 'Pat', phone: '5185550100', email: 'pat@example.com', address_line1: '1 Main St',
  city: 'Plattsburgh', zip: '12901', driveway_size: '2_cars', property_type: 'home', also_clear: [], sms_consent: false,
};

let calls, realFetch, dbExisting;
beforeEach(() => {
  calls = []; dbExisting = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (u.startsWith('https://sb.test/rest/v1/')) {
      const path = u.replace('https://sb.test/rest/v1/', '');
      if ((init.method || 'GET') === 'GET') return ok(path.startsWith('orders') ? dbExisting : path.startsWith('stripe_events') ? [] : []);
      if (init.method === 'POST') return ok([{ id: 'row-' + path.split('?')[0] }], 201);
      return new Response(null, { status: 204 });
    }
    if (u.includes('/v1/checkout/sessions')) return ok({ id: 'cs_test_1', client_secret: 'cs_secret' });
    if (u.includes('/v1/subscriptions/')) return ok({ id: 'sub_1' });
    throw new Error('unexpected fetch ' + u);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const req = (body, headers = {}) => new Request('https://site.test/api/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('checkout creates rows then an embedded session with linked metadata', async () => {
  const res = await checkout({ request: req(signup), env });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { clientSecret: 'cs_secret', publishableKey: 'pk_test' });
  const s = calls.find((c) => c.url.includes('/v1/checkout/sessions'));
  const p = new URLSearchParams(s.body);
  assert.equal(p.get('ui_mode'), 'embedded');
  assert.equal(p.get('mode'), 'subscription');
  assert.equal(p.get('line_items[0][price]'), 'price_m');
  assert.equal(p.get('client_reference_id'), 'row-orders');
  assert.equal(p.get('subscription_data[metadata][property_id]'), 'row-properties');
  assert.equal(p.get('return_url'), 'https://site.test/signup?session_id={CHECKOUT_SESSION_ID}');
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.includes('orders?id=')));
});

test('checkout uses payment mode for one_time', async () => {
  await checkout({ request: req({ ...signup, plan: 'one_time' }), env });
  const p = new URLSearchParams(calls.find((c) => c.url.includes('/v1/checkout/sessions')).body);
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('customer_creation'), 'always');
});

test('checkout validates input and never touches Stripe on bad data', async () => {
  const res = await checkout({ request: req({ ...signup, email: 'x' }), env });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).fields.email);
  assert.equal(calls.length, 0);
});

test('checkout refuses a second recurring plan at an address', async () => {
  dbExisting = [{ id: 'o1' }];
  const res = await checkout({ request: req(signup), env });
  assert.equal(res.status, 409);
  assert.ok(!calls.some((c) => c.url.includes('/v1/checkout')));
});

test('checkout rejects honeypot and bad JSON', async () => {
  assert.equal((await checkout({ request: req({ ...signup, _gotcha: 'x' }), env })).status, 400);
  assert.equal((await checkout({ request: req('{nope'), env })).status, 400);
});

function signedWebhook(event) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return new Request('https://site.test/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body });
}

test('webhook rejects bad signatures', async () => {
  const r = new Request('https://site.test/x', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
  assert.equal((await webhook({ request: r, env })).status, 400);
});

test('webhook: completed monthly checkout activates order and schedules cancel_at', async () => {
  const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: {
    client_reference_id: 'ord1', payment_status: 'paid', amount_total: 24900, subscription: 'sub_1', customer: 'cus_1',
    metadata: { plan: 'monthly', customer_id: 'c1', order_id: 'ord1' } } } };
  const res = await webhook({ request: signedWebhook(event), env });
  assert.equal(res.status, 200);
  const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('orders?id=eq.ord1'));
  const b = JSON.parse(patch.body);
  assert.equal(b.status, 'active'); assert.equal(b.amount_cents, 24900); assert.equal(b.stripe_subscription_id, 'sub_1');
  assert.ok(calls.some((c) => c.url.includes('customers?id=eq.c1') && JSON.parse(c.body).stripe_customer_id === 'cus_1'));
  const sub = calls.find((c) => c.url.endsWith('/v1/subscriptions/sub_1'));
  assert.match(sub.body, /^cancel_at=\d+$/);
  assert.ok(calls.some((c) => c.url.endsWith('/rest/v1/stripe_events') && c.method === 'POST'));
});

test('webhook: unpaid (async) checkout completion does not activate', async () => {
  const event = { id: 'evt_2', type: 'checkout.session.completed', data: { object: { client_reference_id: 'o', payment_status: 'unpaid', metadata: { plan: 'season' } } } };
  assert.equal((await webhook({ request: signedWebhook(event), env })).status, 200);
  assert.ok(!calls.some((c) => c.method === 'PATCH'));
});

test('webhook: payment_failed marks past_due, subscription.deleted marks canceled', async () => {
  await webhook({ request: signedWebhook({ id: 'e3', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_9' } } }), env });
  assert.equal(JSON.parse(calls.find((c) => c.url.includes('stripe_subscription_id=eq.sub_9')).body).status, 'past_due');
  calls.length = 0;
  await webhook({ request: signedWebhook({ id: 'e4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_9' } } }), env });
  assert.equal(JSON.parse(calls.find((c) => c.method === 'PATCH').body).status, 'canceled');
});

test('quote stores form-encoded submissions and drops honeypot hits', async () => {
  const fd = new FormData();
  fd.set('name', 'Pat'); fd.set('phone', '518-555-0100'); fd.set('address', '1 Main St'); fd.append('also_clear', 'Front walk');
  const r = new Request('https://site.test/api/quote', { method: 'POST', body: fd });
  assert.equal((await quote({ request: r, env })).status, 200);
  const row = JSON.parse(calls.find((c) => c.url.endsWith('/quote_requests')).body);
  assert.deepEqual(row.also_clear, ['Front walk']);
  calls.length = 0;
  const bot = new FormData(); bot.set('_gotcha', 'spam');
  assert.equal((await quote({ request: new Request('https://site.test/q', { method: 'POST', body: bot }), env })).status, 200);
  assert.equal(calls.length, 0);
  const bad = new FormData(); bad.set('name', 'x');
  assert.equal((await quote({ request: new Request('https://site.test/q', { method: 'POST', body: bad }), env })).status, 400);
});
