alter table public.dexter_billing_orders add column if not exists mp_first_payment_id text;
create unique index if not exists dexter_billing_orders_first_payment_idx
 on public.dexter_billing_orders(mp_first_payment_id) where mp_first_payment_id is not null;
