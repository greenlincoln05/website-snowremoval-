// POST /api/quote  (form-encoded or JSON)
// Stores a free-quote request in Supabase. Replaces the old Formspree form.
import { json, sb } from '../_lib/util.js';

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export async function onRequestPost({ request, env }) {
  let f;
  try {
    if ((request.headers.get('content-type') || '').includes('application/json')) {
      f = await request.json();
    } else {
      const fd = await request.formData();
      f = Object.fromEntries(fd.entries());
      f.also_clear = fd.getAll('also_clear');
    }
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  if (f._gotcha) return json({ ok: true }); // bot: pretend it worked

  const row = {
    name: clip(f.name, 100),
    phone: clip(f.phone, 30),
    email: clip(f.email, 200).toLowerCase() || null,
    address: clip(f.address, 250),
    driveway_size: clip(f.driveway_size, 60) || null,
    property_type: clip(f.property_type, 60) || null,
    also_clear: (Array.isArray(f.also_clear) ? f.also_clear : []).map((x) => clip(x, 40)).filter(Boolean).slice(0, 10),
    plan_interest: clip(f.plan_interest, 60) || null,
    notes: clip(f.notes, 1000) || null,
  };
  if (!row.name || row.phone.replace(/\D/g, '').length < 10 || !row.address) {
    return json({ error: 'Please include your name, phone number, and address.' }, 400);
  }
  try {
    await sb(env, 'quote_requests', { method: 'POST', body: row });
    return json({ ok: true });
  } catch (err) {
    console.error('quote failed', err);
    return json({ error: 'Something went wrong. Please call or text 518-248-2142.' }, 500);
  }
}
