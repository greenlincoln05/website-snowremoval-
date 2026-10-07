import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateSignup, serviceWindow, formEncode, verifyStripeSignature } from '../functions/_lib/util.js';

const good = {
  plan: 'monthly', name: 'Pat Smith', phone: '(518) 555-0100', email: 'Pat@Example.com',
  address_line1: '1 Main St', city: 'Plattsburgh', zip: '12901',
  driveway_size: '2_cars', property_type: 'home', also_clear: ['front_walk', 'bogus'], sms_consent: true,
};

test('validateSignup accepts a good payload and normalizes it', () => {
  const r = validateSignup(good);
  assert.equal(r.errors, undefined);
  assert.equal(r.value.email, 'pat@example.com');
  assert.deepEqual(r.value.also_clear, ['front_walk']);
  assert.equal(r.value.state, 'NY');
});

test('validateSignup rejects bad fields', () => {
  const r = validateSignup({ ...good, plan: 'x', phone: '123', email: 'nope', zip: '1290', driveway_size: 'huge', name: '' });
  assert.deepEqual(Object.keys(r.errors).sort(), ['driveway_size', 'email', 'name', 'phone', 'plan', 'zip']);
});

test('serviceWindow: monthly mid-winter ends Mar 31 of the same season', () => {
  const w = serviceWindow('monthly', new Date('2026-12-15T12:00:00Z'));
  assert.equal(w.service_start, '2026-12-01');
  assert.equal(w.service_end, '2027-03-31');
  assert.equal(new Date(w.cancel_at * 1000).toISOString(), '2027-04-01T03:59:59.000Z');
});

test('serviceWindow: monthly signup in February still ends this March', () => {
  assert.equal(serviceWindow('monthly', new Date('2027-02-10T12:00:00Z')).service_end, '2027-03-31');
});

test('serviceWindow: monthly signup after Mar 31 rolls to next winter', () => {
  const w = serviceWindow('monthly', new Date('2027-04-10T12:00:00Z'));
  assert.equal(w.service_start, '2027-12-01');
  assert.equal(w.service_end, '2028-03-31');
});

test('serviceWindow: season is Nov 1 to Apr 30; one_time has none', () => {
  const w = serviceWindow('season', new Date('2026-10-07T12:00:00Z'));
  assert.equal(w.service_start, '2026-11-01');
  assert.equal(w.service_end, '2027-04-30');
  assert.equal(serviceWindow('one_time'), null);
});

test('formEncode nests with brackets and skips undefined', () => {
  const s = formEncode({ a: 1, b: { c: 'x y' }, d: [{ e: 2 }], f: undefined }).join('&');
  assert.equal(s, 'a=1&b%5Bc%5D=x%20y&d%5B0%5D%5Be%5D=2');
});

function sign(payload, secret, t) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

test('verifyStripeSignature accepts valid, rejects tampered/stale/malformed', async () => {
  const now = 1_700_000_000;
  const body = '{"id":"evt_1"}';
  await verifyStripeSignature(body, sign(body, 's3cret', now), 's3cret', 300, now);
  await assert.rejects(verifyStripeSignature(body + ' ', sign(body, 's3cret', now), 's3cret', 300, now), /mismatch/);
  await assert.rejects(verifyStripeSignature(body, sign(body, 'other', now), 's3cret', 300, now), /mismatch/);
  await assert.rejects(verifyStripeSignature(body, sign(body, 's3cret', now - 1000), 's3cret', 300, now), /tolerance/);
  await assert.rejects(verifyStripeSignature(body, 'garbage', 's3cret', 300, now), /Malformed/);
});
