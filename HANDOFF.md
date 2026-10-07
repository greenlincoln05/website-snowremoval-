# HANDOFF: North Country Snow Removal website

Read this first. It is the full context for finishing the project. The owner (Lincoln) asked for the next phase to be: **an embedded Stripe checkout page on our own site that collects better customer information (address and more) and keeps it in our own database, using Supabase and Cloudflare hosting.**

## 1. What this business is

- Solo residential snow removal in Plattsburgh, NY, starting with a snow blower (not a plow truck).
- Working name: **North Country Snow Co.** The owner now refers to it as "North Country Snow Removal". **Confirm the final name, then update `index.html`, `design/*`, and the structured data.**
- Phone: **518-248-2142**
- Service area: a walking loop inside the City of Plattsburgh (about 250 homes, a rough visual estimate). The USPS EDDM route for ZIP 12901 that fits best is 790 pieces, $205.40 postage.
- Capacity: roughly 8 to 12 properties per storm solo (estimate). If demand exceeds that, the plan is a second blower plus a part-time helper before any plow truck.
- Priority rule the owner wants: **prepaid monthly and season customers are served first**; one-time visits fit in after.

## 2. Plans and rules (as advertised)

| Plan | Price | Terms | Stripe Payment Link (live today) |
|---|---|---|---|
| One time | $50 per visit | 1-2 car driveway and front walk | https://buy.stripe.com/4gM9AU2t8gt6gpafjr83C02 |
| Monthly unlimited | $249 per month | Every snowfall of 3+ inches, **Dec 1 to Mar 31** | https://buy.stripe.com/cNi4gA3xc2Cgfl60ox83C00 |
| Full season | $1,000, paid up front | **November through April**, same 3-inch trigger | https://buy.stripe.com/14A9AU4Bg2Cggpa2wF83C01 |

- No big-storm surcharge (it was removed on purpose; the website advertises this).
- Larger or unusual driveways: quote by request.
- Local price check: estimate sites put Plattsburgh at about $40 to $100 per visit. These are estimates, not competitor price sheets.
- **Open issue:** the monthly subscription keeps billing until cancelled. It must stop after March 31. See section 6.
- The owner should verify in Stripe that each link charges the amounts above.

## 3. What exists in this repo

```
public/                  Static site served by Cloudflare Pages (pages_build_output_dir)
  index.html             Standalone, SEO-ready, mobile-first one-page site
  signup.html            Plan + property form, then embedded Stripe Checkout
  _redirects             /s -> /signup?plan=monthly (short link for the flyer QR)
  robots.txt, sitemap.xml  (still contain YOURDOMAIN.com)
functions/               Cloudflare Pages Functions (become /api/* routes)
  api/checkout.js        Validate, write Supabase rows, create embedded Checkout Session
  api/stripe-webhook.js  Verify signature, keep orders in sync (idempotent)
  api/session-status.js  Return page: did the payment complete?
  api/quote.js           Quote form -> quote_requests
  _lib/util.js           Validation, season dates, Supabase + Stripe REST helpers
supabase/schema.sql      Tables + RLS (run in the Supabase SQL editor)
test/                    `npm test` (node:test, no dependencies)
wrangler.toml, package.json, .env.example
assets/                  QR code for the monthly Stripe link (PNG, SVG)
design/                  Source for the print flyer and the storefront mockup
  canvas.json            Board layout (flyer front/back at 6.5x9in, storefront page)
  Main.dc.html           Flyer FRONT
  Back.dc.html           Flyer BACK
  Store.dc.html          Storefront page design (superseded by public/index.html)
HANDOFF.md               This file
README.md
```

### Build status against section 5
Code written and unit-tested with mocked Stripe/Supabase (not yet run against real accounts): steps 2 (schema file), 4, 5, 6, 7, 8, 9 (redirect only; QR not regenerated), and the robots/sitemap part of 13. Still open: 1, 3 (needs accounts), 10, 11, 12, 14, and the questions in section 6. Quote-form spam protection is the honeypot only; add a Cloudflare rate-limiting rule or Turnstile. Quote requests are stored but the owner is not emailed yet.
Deviations to check: the Stripe API version is pinned to `2024-06-20` in `functions/_lib/util.js` (create the webhook endpoint with a matching API version); the monthly `cancel_at` is set from the webhook after checkout, not at session creation; a monthly signup made before Dec 1 is billed immediately and then monthly until Mar 31 (add a `trial_end` if billing should start Dec 1).

The `design/*.dc.html` files run on Claude's Design artifact runtime (`support.js`), which is **not** in this repo. They are source records. The live design canvas is at https://claude.ai/artifact/3H2ez4aABEQPWNP2JknvQd. Export flyer PDFs from there.

### Website (`index.html`)
- Sections: hero, three plan cards (Stripe links), quote form, "longer season, no surprise fees", how it works, Plattsburgh sidewalk rules, landlords, FAQ, footer.
- Mobile-first with a sticky bottom bar ("Get a quote" / "See plans"), 52px tap targets, 17px+ inputs.
- SEO: title, meta description, canonical, Open Graph, LocalBusiness and FAQPage JSON-LD.
- Brand: navy `#0A3161`, red `#B31942`, white, snow tint `#EAF1F9`. Fonts: Oswald (headings), Public Sans (body), loaded from Google Fonts.
- Snowflake motif is inline SVG.
- **Placeholders still in the file:** `https://YOURDOMAIN.com/` (canonical, og:url, JSON-LD url), `[YOUR SERVICE AREA]`, form action `https://formspree.io/f/REPLACE_FORM_ID`, and the stand-in business name.
- The sidewalk-rule section cites the City of Plattsburgh: owners of property bordering a sidewalk must clear it within 24 hours after a snow event ends, and for rentals the owner is ultimately responsible. Source: https://www.cityofplattsburgh-ny.gov/node/3907

### Flyer
- Two-sided, 6.5 x 9 in, mailed with USPS **Every Door Direct Mail Retail** (flat rate $0.260 per piece as of July 12, 2026; 200 piece minimum; piece must be over 6.125 in tall or 11.5 in long to qualify as a flat, so 6.5 x 9 is the minimum practical size).
- The printer or EDDM service must add the required USPS indicia. A blank area for it may need to be reserved; confirm with the chosen printer.
- Front: headline, $249/month offer, QR code. Back: three-plan price list, how it works, fine print.
- **Important:** the QR currently encodes the monthly Stripe Payment Link directly. Do not print until the QR points to a redirect on our own domain (see section 5, step 9).

## 4. Target architecture for the next phase

Goal: customers choose a plan, enter their details on **our** page, pay in an **embedded Stripe Checkout**, and every detail lands in **our Supabase database**.

```
Browser (Cloudflare Pages, static + JS)
   |  1. customer fills our form (name, phone, email, service address,
   |     driveway size, property type, extras, notes, SMS consent)
   v
Cloudflare Pages Function  POST /api/checkout
   |  2. validate input, upsert customer + property in Supabase (status: pending)
   |  3. create Stripe Checkout Session (embedded) with metadata linking to our rows
   v
Stripe Embedded Checkout (mounted on our /signup page)
   |  4. customer pays
   v
Stripe webhook  ->  Cloudflare Pages Function  POST /api/stripe-webhook
      5. verify signature, mark order paid/active/failed in Supabase (idempotent)
```

Why this shape: the database stays the source of truth for customer and property data, and Stripe only handles payment. Collecting the property details on our page before checkout means we are not limited by Stripe's custom-field caps, and we can link every payment back to a property.

### Tech choices
- **Hosting:** Cloudflare Pages with Pages Functions (`/functions`) for the API routes. Static `index.html` stays the front end. Add a `/signup` page for embedded checkout.
- **Database:** Supabase (Postgres). Row Level Security **on** for every table. No anonymous policies. All writes go through the server functions using the service role key, which never reaches the browser.
- **Payments:** Stripe Embedded Checkout (Checkout Sessions). Use the current Stripe docs for the exact embedded-mode parameter names; they have changed across API versions. Use Stripe **test mode** until the full flow is verified.
- **Cloudflare cost note:** the owner said "$12/month hosting." Pages and Functions have a free tier, and the owner may be thinking of the annual domain cost (a `.com` is roughly $10 to $12 per year). **Verify which plan he means and do not pay for more than needed.**

## 5. Next steps (in order)

1. **Confirm the final business name and domain.** Update `public/index.html` (title, headings, JSON-LD, footer, canonical), flyer files, and any copy.
2. **Create the Supabase project.** Add `supabase/schema.sql` from the sketch in section 7. Enable RLS on all tables.
3. **Set up the Cloudflare Pages project** from this repo. Add env vars (section 8). Add the custom domain.
4. **Build `/api/checkout`:** validate input server-side, upsert `customers` and `properties`, create an `orders` row (`pending`), create the Stripe Checkout Session, return the `client_secret`. Attach `customer_id`, `property_id`, `order_id`, and plan as session metadata, and set `client_reference_id`.
5. **Build the `/signup` page:** a short form (name, phone, email, service address, driveway size in cars, property type, also-clear checkboxes, notes, SMS consent checkbox), then mount embedded Checkout. Preselect the plan from a query string (`/signup?plan=monthly`). Keep it mobile-first and match the brand.
6. **Build `/api/stripe-webhook`:** verify the signature, store each event id for idempotency, and handle at least `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, and `customer.subscription.deleted`. Update `orders` status accordingly.
7. **Replace the Formspree quote form** with a function that writes to `quote_requests` in Supabase and optionally emails the owner. Keep the same fields. Add basic spam protection (honeypot already exists; add rate limiting or Turnstile).
8. **Point the website's plan buttons at `/signup?plan=...`.** Keep the three Payment Links as a working fallback until the new flow is proven.
9. **Make the QR code redirect through our own domain** (for example `https://DOMAIN/s` redirecting to `/signup?plan=monthly`). Regenerate `assets/qr-monthly-signup.*` and the flyer front. This lets the destination change after the flyers are printed.
10. **One-time visit booking (storm-based, not a normal calendar).** Snow does not follow a calendar, so use a request model:
    - After paying (or authorizing), the customer submits a request for the next snowfall of 3+ inches, with an optional "needed by" time.
    - Monthly and season customers are always scheduled first (priority 1). One-time visits are priority 2.
    - Add a per-storm capacity cap set by the owner. Over the cap, requests go to a waitlist or the next storm.
    - The owner confirms by text. Consider authorizing the card at booking and capturing it after the job is done (manual capture on the PaymentIntent). **Verify how this works with Checkout before relying on it.**
    - An optional Google Calendar or Cal.com link can be offered for customers who want a specific date (for example before a vacation).
11. **Admin view for the owner:** a password-protected page (Supabase Auth, one admin user) listing active customers by address with plan, status, driveway size, notes, and priority; storm-day route list; CSV export.
12. **Legal and compliance pages:** privacy policy, terms of service (cancellation, service limits, 3-inch trigger, liability), and SMS consent language. Texting customers requires clear opt-in (TCPA). Mailing is EDDM only; never put flyers in mailboxes by hand.
13. **SEO launch tasks:** `sitemap.xml`, `robots.txt`, Google Business Profile (service-area business, same name and phone as the site), Google Search Console, collect the first real reviews. Do not invent reviews.
14. **Print the flyers** after steps 9 and a real scan test from a printed proof. Order through an EDDM printer or Staples at 6.5 x 9.

## 6. Open questions and things to verify (do not assume)

- **Stopping the monthly subscription after March 31.** Options: set `cancel_at` on the subscription (via API after creation or in the webhook) or end after a fixed number of payments. Confirm the supported approach in current Stripe docs.
- **Season-plan date range** (November through April) versus monthly (December through March): confirm the owner is happy with that asymmetry. The season plan is effectively six months for $1,000.
- **Sales tax:** whether snow removal is taxable in New York and what to set up in Stripe. Confirm with the NYS Department of Taxation and Finance. Do not guess.
- **One-time plan authorization and capture** behavior in Checkout (see step 10).
- **Duplicate subscriptions:** prevent one customer or address from getting charged twice (match on email plus address).
- **Insurance:** the owner needs general liability coverage before taking customers. Many landlords and businesses will require a certificate.
- **Business registration:** check whether Plattsburgh or New York requires a DBA or registration for the final business name.
- **Competitor claim on the site:** the season card says "Longest coverage." This is not verified. Confirm or soften it.

## 7. Database sketch (starting point, not final)

```sql
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  sms_consent boolean not null default false,
  stripe_customer_id text unique,
  created_at timestamptz not null default now()
);

create table properties (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  address_line1 text not null,
  address_line2 text,
  city text not null,
  state text not null default 'NY',
  zip text,
  driveway_size text not null check (driveway_size in ('1_car','2_cars','3_plus','long_unusual','walks_only')),
  property_type text not null check (property_type in ('home','rental','business')),
  also_clear text[] not null default '{}',   -- front_walk, steps_porch, public_sidewalk
  notes text,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  property_id uuid not null references properties(id),
  plan text not null check (plan in ('one_time','monthly','season')),
  status text not null default 'pending'
    check (status in ('pending','paid','active','past_due','canceled','refunded')),
  amount_cents integer,
  stripe_checkout_session_id text unique,
  stripe_subscription_id text,
  stripe_payment_intent_id text,
  service_start date,
  service_end date,
  created_at timestamptz not null default now()
);

create table visit_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  property_id uuid not null references properties(id),
  storm_date date,
  needed_by time,
  priority smallint not null default 2,       -- 1 = monthly/season, 2 = one-time
  status text not null default 'requested'
    check (status in ('requested','confirmed','waitlist','done','skipped')),
  notes text,
  created_at timestamptz not null default now()
);

create table quote_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  address text not null,
  driveway_size text,
  property_type text,
  also_clear text[],
  plan_interest text,
  notes text,
  status text not null default 'new',
  created_at timestamptz not null default now()
);

create table stripe_events (
  id text primary key,                         -- Stripe event id, for idempotency
  type text not null,
  received_at timestamptz not null default now()
);

alter table customers      enable row level security;
alter table properties     enable row level security;
alter table orders         enable row level security;
alter table visit_requests enable row level security;
alter table quote_requests enable row level security;
alter table stripe_events  enable row level security;
-- No anon or authenticated policies. Server functions use the service role key.
```

## 8. Environment variables (Cloudflare Pages, never commit)

```
STRIPE_SECRET_KEY
STRIPE_PUBLISHABLE_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_ONE_TIME
STRIPE_PRICE_MONTHLY
STRIPE_PRICE_SEASON
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Use test-mode keys first. Keep an `.env.example` with names only. `.env` and `.dev.vars` are already in `.gitignore`.

## 9. Working agreements with the owner

- Mobile first: almost all visitors will arrive by scanning the flyer QR code on a phone.
- Keep the look: navy, red, white, snowflakes, campaign-style flyer feel; simple, not "AI generated" looking.
- No invented reviews, stats, or competitor claims.
- Ask before spending money (domains, paid plans, ad spend).
- The owner prefers short, direct explanations and will paste Stripe links and other values when ready.
