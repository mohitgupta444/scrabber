-- Gateway-backed pickup payments. Balances are a transaction ledger; funds are
-- routed by Razorpay to the customer's linked account and are not stored here.
create table public.payment_recipients (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  razorpay_account_id text not null unique,
  created_at timestamptz not null default now()
);
alter table public.payment_recipients enable row level security;
revoke all on public.payment_recipients from anon, authenticated;

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  pickup_id uuid not null unique references public.pickup_requests(id) on delete restrict,
  payer_id uuid not null references public.profiles(id) on delete restrict,
  payee_id uuid not null references public.profiles(id) on delete restrict,
  amount_paise bigint not null check (amount_paise > 0),
  platform_fee_paise bigint not null check (platform_fee_paise >= 0 and platform_fee_paise < amount_paise),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  razorpay_order_id text unique,
  razorpay_payment_id text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index wallet_transactions_payer_created_idx on public.wallet_transactions (payer_id, created_at desc);
create index wallet_transactions_payee_created_idx on public.wallet_transactions (payee_id, created_at desc);
alter table public.wallet_transactions enable row level security;
create policy "Participants read wallet transactions" on public.wallet_transactions
  for select to authenticated using (payer_id = (select auth.uid()) or payee_id = (select auth.uid()) or public.is_admin());
grant select on public.wallet_transactions to authenticated;

create or replace function public.mark_wallet_payment_paid(
  transaction_order_id text,
  transaction_payment_id text
)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.wallet_transactions;
  was_updated boolean := false;
begin
  update public.wallet_transactions t
  set status = 'paid', razorpay_payment_id = transaction_payment_id, paid_at = now()
  where t.razorpay_order_id = transaction_order_id and t.status = 'pending'
  returning t.* into result;
  was_updated := found;
  if result.id is null then
    select * into result from public.wallet_transactions t
      where t.razorpay_order_id = transaction_order_id and t.razorpay_payment_id = transaction_payment_id and t.status = 'paid';
  end if;
  if result.id is null then
    raise exception 'Payment order not found or already settled' using errcode = 'P0002';
  end if;
  if was_updated then
    insert into public.notifications (user_id, title, body)
    values (result.payee_id, 'Pickup payment received', 'A dealer paid ₹' || (result.amount_paise - result.platform_fee_paise)::numeric / 100 || ' to your linked bank account through Razorpay.');
  end if;
  return result;
end;
$$;
revoke all on function public.mark_wallet_payment_paid(text, text) from public, anon, authenticated;
grant execute on function public.mark_wallet_payment_paid(text, text) to service_role;
