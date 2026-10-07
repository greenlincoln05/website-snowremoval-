// GET /api/session-status?session_id=cs_...
// Lets the return page show whether the payment went through.
import { json, stripe } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ error: 'Invalid session.' }, 400);
  try {
    const s = await stripe(env, `checkout/sessions/${id}`);
    return json({ status: s.status, payment_status: s.payment_status, email: s.customer_details?.email || s.customer_email || null });
  } catch (err) {
    console.error('session-status failed', err);
    return json({ error: 'Could not load your order.' }, 500);
  }
}
