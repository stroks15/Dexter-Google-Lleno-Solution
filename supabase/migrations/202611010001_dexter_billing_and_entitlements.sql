-- Dexter billing: isolated names avoid collisions in the shared veterinary project.
do $$ begin create type public.dexter_plan_type as enum ('free','premium_monthly','premium_lifetime');
exception when duplicate_object then null; end $$;

create table if not exists public.dexter_user_entitlements (
 user_id uuid primary key references auth.users(id) on delete cascade,
 plan_type public.dexter_plan_type not null default 'free',
 bytes_transferred bigint not null default 0 check(bytes_transferred>=0),
 discount_coupon_applied varchar(80),
 mp_preapproval_id text unique,
 subscription_status text check(subscription_status is null or subscription_status in ('authorized','pending','paused','cancelled','expired')),
 current_period_end timestamptz,
 lifetime_granted_at timestamptz,
 updated_at timestamptz not null default now()
);
create table if not exists public.dexter_coupons (
 code varchar(80) primary key, discount_mxn numeric(10,2) not null default 0 check(discount_mxn>=0),
 grants_lifetime boolean not null default false, active boolean not null default true,
 created_at timestamptz not null default now(),
 check(not(grants_lifetime and discount_mxn>0))
);
create table if not exists public.dexter_coupon_redemptions (
 id uuid primary key default gen_random_uuid(), coupon_code varchar(80) not null references public.dexter_coupons(code),
 user_id uuid not null references auth.users(id) on delete cascade, redeemed_at timestamptz not null default now(),
 unique(coupon_code,user_id)
);
create table if not exists public.dexter_billing_orders (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 plan_type public.dexter_plan_type not null check(plan_type in ('premium_monthly','premium_lifetime')),
 amount_mxn numeric(10,2) not null check(amount_mxn>=0), discount_coupon_applied varchar(80),
 status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled','authorized')),
 payment_provider text not null default 'mercadopago' check(payment_provider='mercadopago'),
 mp_preference_id text, mp_payment_id text unique, mp_preapproval_id text unique,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists dexter_billing_orders_user_created_idx on public.dexter_billing_orders(user_id,created_at desc);
create index if not exists dexter_billing_orders_status_idx on public.dexter_billing_orders(status,created_at desc);

insert into public.dexter_coupons(code,discount_mxn,grants_lifetime,active) values
 ('DEXTERH4CK',30,false,true),('LIAM-LIZ-FER-H4CK',0,true,true)
on conflict(code) do update set discount_mxn=excluded.discount_mxn,grants_lifetime=excluded.grants_lifetime,active=excluded.active;

create or replace function public.dexter_enforce_free_transfer_limit()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.plan_type='free' and new.bytes_transferred>2147483648 then
  raise exception 'free_transfer_limit_exceeded' using errcode='check_violation';
 end if;
 new.updated_at=now(); return new;
end $$;
drop trigger if exists dexter_entitlement_limit_guard on public.dexter_user_entitlements;
create trigger dexter_entitlement_limit_guard before insert or update of plan_type,bytes_transferred
on public.dexter_user_entitlements for each row execute function public.dexter_enforce_free_transfer_limit();

create or replace function public.dexter_add_transferred_bytes(p_user_id uuid,p_bytes bigint)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare v_total bigint;
begin
 if p_bytes is null or p_bytes<0 then raise exception 'invalid_byte_count' using errcode='22023'; end if;
 insert into public.dexter_user_entitlements(user_id) values(p_user_id) on conflict(user_id) do nothing;
 update public.dexter_user_entitlements set bytes_transferred=bytes_transferred+p_bytes,updated_at=now()
 where user_id=p_user_id and (plan_type<>'free' or bytes_transferred+p_bytes<=2147483648)
 returning bytes_transferred into v_total;
 if v_total is null then raise exception 'free_transfer_limit_exceeded' using errcode='check_violation'; end if;
 return v_total;
end $$;
revoke all on function public.dexter_add_transferred_bytes(uuid,bigint) from public,anon,authenticated;
grant execute on function public.dexter_add_transferred_bytes(uuid,bigint) to service_role;

alter table public.dexter_user_entitlements enable row level security;
alter table public.dexter_coupons enable row level security;
alter table public.dexter_coupon_redemptions enable row level security;
alter table public.dexter_billing_orders enable row level security;
drop policy if exists "dexter entitlement read own" on public.dexter_user_entitlements;
create policy "dexter entitlement read own" on public.dexter_user_entitlements for select to authenticated using((select auth.uid())=user_id);
drop policy if exists "dexter coupon redemption read own" on public.dexter_coupon_redemptions;
create policy "dexter coupon redemption read own" on public.dexter_coupon_redemptions for select to authenticated using((select auth.uid())=user_id);
drop policy if exists "dexter billing order read own" on public.dexter_billing_orders;
create policy "dexter billing order read own" on public.dexter_billing_orders for select to authenticated using((select auth.uid())=user_id);
revoke all on public.dexter_coupons from anon,authenticated;
revoke all on public.dexter_coupon_redemptions from anon,authenticated;
revoke insert,update,delete on public.dexter_user_entitlements from anon,authenticated;
revoke insert,update,delete on public.dexter_billing_orders from anon,authenticated;
grant select on public.dexter_user_entitlements,public.dexter_coupon_redemptions,public.dexter_billing_orders to authenticated;
grant all on public.dexter_user_entitlements,public.dexter_coupons,public.dexter_coupon_redemptions,public.dexter_billing_orders to service_role;
