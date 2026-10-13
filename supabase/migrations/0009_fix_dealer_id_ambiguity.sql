-- Avoid PL/pgSQL name collisions between the local dealer actor and columns
-- named dealer_id in pickup_requests.
create or replace function public.pay_completed_pickup_from_wallet(request_id uuid)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  dealer_actor_id uuid := (select auth.uid());
  pickup public.pickup_requests;
  amount_paise bigint;
  dealer_balance_paise bigint;
  existing public.wallet_transactions;
  result public.wallet_transactions;
begin
  if dealer_actor_id is null or not public.is_verified_dealer() then
    raise exception 'Verified dealer access required' using errcode = '42501';
  end if;

  -- Keep the same pickup-then-profile lock order as customer confirmation.
  select * into pickup
  from public.pickup_requests p
  where p.id = request_id
    and p.dealer_id = dealer_actor_id
    and p.status = 'completed'
  for update;
  if pickup.id is null or pickup.final_amount is null or pickup.final_amount <= 0 then
    raise exception 'Completed pickup with a valid final amount not found' using errcode = 'P0002';
  end if;
  perform 1 from public.profiles pr where pr.id = dealer_actor_id for update;

  select * into existing
  from public.wallet_transactions t
  where t.pickup_id = request_id;
  if existing.id is not null then
    if existing.transaction_type = 'pickup_wallet_payment' and existing.status = 'paid'
      and existing.payer_id = dealer_actor_id and existing.payee_id = pickup.customer_id then
      return existing;
    end if;
    raise exception 'A payment is already recorded for this pickup' using errcode = '23505';
  end if;

  amount_paise := round(pickup.final_amount * 100)::bigint;
  select coalesce(sum(case
    when t.payee_id = dealer_actor_id
      and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
      then t.amount_paise - t.platform_fee_paise
    when t.payer_id = dealer_actor_id
      and t.transaction_type in ('wallet_transfer', 'pickup_wallet_payment')
      then -t.amount_paise
    else 0
  end), 0)::bigint
  into dealer_balance_paise
  from public.wallet_transactions t
  where t.status = 'paid'
    and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
    and (t.payee_id = dealer_actor_id or t.payer_id = dealer_actor_id);
  if dealer_balance_paise < amount_paise then
    raise exception 'Insufficient wallet balance for this pickup payment' using errcode = 'P0001';
  end if;

  insert into public.wallet_transactions (
    pickup_id, payer_id, payee_id, amount_paise, platform_fee_paise,
    status, transaction_type, note, paid_at
  ) values (
    request_id, dealer_actor_id, pickup.customer_id, amount_paise, 0,
    'paid', 'pickup_wallet_payment', 'Pickup payment', now()
  ) returning * into result;

  insert into public.notifications (user_id, title, body)
  values (pickup.customer_id, 'Pickup payment received',
    'The dealer sent ' || chr(8377) || (amount_paise::numeric / 100)::text || ' to your app wallet.');
  return result;
end;
$$;

revoke all on function public.pay_completed_pickup_from_wallet(uuid) from public, anon;
grant execute on function public.pay_completed_pickup_from_wallet(uuid) to authenticated;

create or replace function public.dealer_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  dealer_actor_id uuid := (select auth.uid());
begin
  if not public.is_verified_dealer() then
    raise exception 'Verified dealer access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'totalEarnings', coalesce((
      select sum(p.final_amount) from public.pickup_requests p
      where p.dealer_id = dealer_actor_id and p.status = 'completed'
    ), 0),
    'completedPickups', (
      select count(*) from public.pickup_requests p
      where p.dealer_id = dealer_actor_id and p.status = 'completed'
    ),
    'averageTransaction', coalesce((
      select avg(p.final_amount) from public.pickup_requests p
      where p.dealer_id = dealer_actor_id and p.status = 'completed'
    ), 0)
  );
end;
$$;

revoke all on function public.dealer_dashboard_stats() from public, anon;
grant execute on function public.dealer_dashboard_stats() to authenticated;
