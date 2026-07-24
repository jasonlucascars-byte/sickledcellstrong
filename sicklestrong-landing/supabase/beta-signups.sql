-- ============================================================
-- SickleStrong — founding beta signups
-- Run this in the Supabase SQL editor (or `supabase db` migration).
-- Creates the table, locks it down with Row Level Security, and
-- installs two SECURITY DEFINER functions:
--   claim_beta_signup(...) — insert + dedupe + concurrency-safe
--                            founding-family assignment (cap = 50)
--   beta_counts()          — aggregate-only public counter
-- Only the service role (used by the Netlify Functions) can reach the
-- table; the anon/public roles get NOTHING.
-- ============================================================

create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- ---------- table ----------
create table if not exists public.beta_signups (
  id              uuid primary key default gen_random_uuid(),
  first_name      text not null check (char_length(first_name) between 1 and 80),
  email           text not null,                  -- stored normalized (lowercase, trimmed)
  care_role       text not null check (care_role in
                    ('one-child','multiple-children','myself','family-member','caregiver')),
  referral_source text check (referral_source is null or char_length(referral_source) <= 200),
  consent_at      timestamptz not null,
  submitted_at    timestamptz not null default now(),
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  status          text not null default 'new'
                    check (status in ('new','accepted','waitlisted','declined')),
  founding_family boolean not null default false
);

-- unique on the normalized email (prevents duplicate beta records)
create unique index if not exists beta_signups_email_key on public.beta_signups (email);

-- helpful partial index for the founding-family count
create index if not exists beta_signups_founding_idx
  on public.beta_signups (founding_family) where founding_family = true;

-- ---------- row level security ----------
alter table public.beta_signups enable row level security;
-- NO policies are created on purpose: the anon and authenticated roles
-- therefore have zero access. The service role (used only inside the
-- Netlify Functions) bypasses RLS. The public counter is served through
-- beta_counts() below, which returns aggregate numbers only.
revoke all on public.beta_signups from anon, authenticated;

-- ============================================================
-- claim_beta_signup — atomic insert with de-dup + founding assignment
-- Returns one row describing the outcome. `out_is_new` is false when the
-- email was already registered (friendly duplicate handling).
-- ============================================================
create or replace function public.claim_beta_signup(
  p_first_name       text,
  p_email            text,
  p_care_role        text,
  p_referral_source  text default null,
  p_utm_source       text default null,
  p_utm_medium       text default null,
  p_utm_campaign     text default null
)
returns table (out_email text, out_founding boolean, out_is_new boolean, out_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := lower(trim(p_email));
  v_first    text := trim(p_first_name);
  v_ref      text := nullif(trim(coalesce(p_referral_source, '')), '');
  v_founding boolean := false;
  v_count    int;
  c_limit    constant int := 50;   -- founding-family cap
  r          public.beta_signups%rowtype;
begin
  -- already registered? return the existing record (duplicate).
  select b.* into r from public.beta_signups b where b.email = v_email;
  if found then
    out_email := r.email; out_founding := r.founding_family;
    out_is_new := false;  out_status := r.status;
    return next; return;
  end if;

  -- Serialize the count-then-insert so the 50-family cap can never be
  -- exceeded, even with many simultaneous submissions. The advisory lock
  -- is released automatically at the end of the transaction.
  perform pg_advisory_xact_lock(hashtext('sicklestrong_founding_family'));

  select count(*) into v_count from public.beta_signups b where b.founding_family = true;
  if v_count < c_limit then
    v_founding := true;
  end if;

  begin
    insert into public.beta_signups
      (first_name, email, care_role, referral_source, consent_at,
       utm_source, utm_medium, utm_campaign, founding_family)
    values
      (v_first, v_email, p_care_role, v_ref, now(),
       p_utm_source, p_utm_medium, p_utm_campaign, v_founding)
    returning email, founding_family, status into out_email, out_founding, out_status;
    out_is_new := true;
    return next;
  exception when unique_violation then
    -- Race: another request inserted the same email between our check and
    -- insert. Treat it as an existing signup.
    select b.* into r from public.beta_signups b where b.email = v_email;
    out_email := r.email; out_founding := r.founding_family;
    out_is_new := false;  out_status := r.status;
    return next;
  end;
end;
$$;

-- ============================================================
-- beta_counts — aggregate numbers only (no personal data)
-- ============================================================
create or replace function public.beta_counts()
returns table (founding_count int, founding_limit int, total int)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*)::int from public.beta_signups where founding_family = true) as founding_count,
    50 as founding_limit,
    (select count(*)::int from public.beta_signups) as total;
$$;

-- Only the service role may execute these functions.
revoke all on function public.claim_beta_signup(text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.beta_counts() from public, anon, authenticated;
grant execute on function public.claim_beta_signup(text,text,text,text,text,text,text) to service_role;
grant execute on function public.beta_counts() to service_role;

-- ------------------------------------------------------------
-- Verify (optional):
--   select * from public.claim_beta_signup('Test','test@example.com','myself');
--   select * from public.beta_counts();
--   select count(*) from public.beta_signups;  -- service role only
-- ------------------------------------------------------------
