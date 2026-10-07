// Shared helpers for the Pages Functions. No dependencies: runs on Workers.

export const STRIPE_API_VERSION = '2024-06-20';

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ---- Validation -----------------------------------------------------------

export const PLANS = ['one_time', 'monthly', 'season'];
export const DRIVEWAY_SIZES = ['1_car', '2_cars', '3_plus', 'long_unusual', 'walks_only'];
export const PROPERTY_TYPES = ['home', 'rental', 'business'];
export const ALSO_CLEAR = ['front_walk', 'steps_porch', 'public_sidewalk'];

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// Returns { value } on success or { errors: { field: message } }.
export function validateSignup(input) {
  const errors = {};
  const v = {
    plan: clean(input.plan, 20),
    name: clean(input.name, 100),
    phone: clean(input.phone, 30),
    email: clean(input.email, 200).toLowerCase(),
    sms_consent: input.sms_consent === true,
    address_line1: clean(input.address_line1, 150),
    address_line2: clean(input.address_line2, 100),
    city: clean(input.city, 80),
    state: 'NY',
    zip: clean(input.zip, 10),
    driveway_size: clean(input.driveway_size, 20),
    property_type: clean(input.property_type, 20),
    also_clear: Array.isArray(input.also_clear) ? [...new Set(input.also_clear.filter((x) => ALSO_CLEAR.includes(x)))] : [],
    notes: typeof input.notes === 'string' ? input.notes.trim().slice(0, 1000) : '',
  };
  if (!PLANS.includes(v.plan)) errors.plan = 'Choose a plan.';
  if (!v.name) errors.name = 'Enter your name.';
  if (v.phone.replace(/\D/g, '').length < 10) errors.phone = 'Enter a 10-digit phone number.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = 'Enter a valid email address.';
  if (!v.address_line1) errors.address_line1 = 'Enter the service address.';
  if (!v.city) errors.city = 'Enter the city.';
  if (!/^\d{5}$/.test(v.zip)) errors.zip = 'Enter a 5-digit ZIP code.';
  if (!DRIVEWAY_SIZES.includes(v.driveway_size)) errors.driveway_size = 'Choose a driveway size.';
  if (!PROPERTY_TYPES.includes(v.property_type)) errors.property_type = 'Choose a property type.';
  return Object.keys(errors).length ? { errors } : { value: v };
}

// ---- Seasons --------------------------------------------------------------

// Monthly runs Dec 1 - Mar 31. Season runs Nov 1 - Apr 30. If this winter's window has
// already ended, the next winter is used.
export function serviceWindow(plan, now = new Date()) {
  if (plan === 'one_time') return null;
  let year = now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const build = (y) => (plan === 'monthly'
    ? { start: [y, 11, 1], end: [y + 1, 2, 31] }
    : { start: [y, 10, 1], end: [y + 1, 3, 30] });
  const iso = ([y, m, d]) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  // Last moment of the end day in New York (EDT/EST). 04:59:59 UTC covers both after 1 Apr.
  const endMoment = ([y, m, d]) => Date.UTC(y, m, d + 1, 3, 59, 59) / 1000;
  let w = build(year);
  if (endMoment(w.end) * 1000 < now.getTime()) w = build(year + 1);
  return { service_start: iso(w.start), service_end: iso(w.end), cancel_at: Math.floor(endMoment(w.end)) };
}

// ---- Supabase (PostgREST over fetch) ---------------------------------------

export async function sb(env, path, { method = 'GET', body, prefer } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export const eq = (v) => `eq.${encodeURIComponent(v)}`;

// ---- Stripe (REST over fetch) ----------------------------------------------

// Stripe wants form-encoded bodies with bracket notation for nesting.
export function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') formEncode(item, `${key}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === 'object') {
      formEncode(v, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return out;
}

export async function stripe(env, path, params, method = params ? 'POST' : 'GET') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': STRIPE_API_VERSION,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? formEncode(params).join('&') : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path} -> ${res.status}: ${data?.error?.message}`);
  return data;
}

// Verifies the Stripe-Signature header (HMAC-SHA256 of "<t>.<payload>"). Throws on failure.
export async function verifyStripeSignature(payload, header, secret, toleranceSec = 300, nowSec = Date.now() / 1000) {
  const items = (header || '').split(',').map((p) => p.trim().split('='));
  const t = items.find(([k]) => k === 't')?.[1];
  const sigs = items.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) throw new Error('Malformed Stripe-Signature header');
  if (Math.abs(nowSec - Number(t)) > toleranceSec) throw new Error('Stripe signature timestamp outside tolerance');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!sigs.some((s) => timingSafeEqual(s, expected))) throw new Error('Stripe signature mismatch');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
