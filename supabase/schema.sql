-- North Country Snow Removal: database schema (Supabase / Postgres).
-- Run in the Supabase SQL editor. Safe to re-run: uses "if not exists".
-- All access goes through server functions with the service role key.
-- RLS is ON with no policies, so the anon and authenticated roles can read and write nothing.

create extension if not exists pgcrypto;

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  sms_consent boolean not null default false,
  stripe_customer_id text unique,
  created_at timestamptz not null default now()
);
-- One customer row per email address (emails are stored lowercase by the API).
create unique index if not exists customers_email_key on customers (lower(email)) where email is not null;

create table if not exists properties (
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
create index if not exists properties_customer_idx on properties (customer_id);

create table if not exists orders (
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
create index if not exists orders_property_idx on orders (property_id);
create index if not exists orders_subscription_idx on orders (stripe_subscription_id);

create table if not exists visit_requests (
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

create table if not exists quote_requests (
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

create table if not exists stripe_events (
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
-- No anon or authenticated policies on purpose. Server functions use the service role key.
