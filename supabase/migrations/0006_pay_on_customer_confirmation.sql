create or replace function public.confirm_pickup_completion(request_id uuid)
returns public.pickup_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  customer_actor uuid := (select auth.uid());
  completed public.pickup_requests;
  existing_payment public.wallet_transactions;
  amount_paise bigint;
  dealer_balance_paise bigint;
begin
  select * into completed
  from public.pickup_requests p
  where p.id = request_id
    and p.customer_id = customer_actor
    and p.status = 'awaiting_confirmation'
  for update;

  if completed.id is null then
    raise exception 'Pickup is not waiting for your confirmation' using errcode = 'P0002';
  end if;
  if completed.dealer_id is null or completed.final_amount is null or completed.final_amount <= 0 then
    raise exception 'Pickup final amount is invalid' using errcode = '22023';
  end if;

  amount_paise := round(completed.final_amount * 100)::bigint;
  perform 1 from public.profiles where id = completed.dealer_id for update;

  select coalesce(sum(case
    when t.payee_id = completed.dealer_id
      and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
      then t.amount_paise - t.platform_fee_paise
    when t.payer_id = completed.dealer_id
      and t.transaction_type in ('wallet_transfer', 'pickup_wallet_payment')
      then -t.amount_paise
    else 0
  end), 0)::bigint
  into dealer_balance_paise
  from public.wallet_transactions t
  where t.status = 'paid'
    and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
    and (t.payee_id = completed.dealer_id or t.payer_id = completed.dealer_id);

  if dealer_balance_paise < amount_paise then
    raise exception 'Dealer wallet has insufficient balance. Ask the dealer to add app credits before confirming.' using errcode = 'P0001';
  end if;

  select * into existing_payment
  from public.wallet_transactions t
  where t.pickup_id = completed.id;
  if existing_payment.id is not null then
    raise exception 'A payment is already recorded for this pickup' using errcode = '23505';
  end if;

  update public.pickup_requests p
  set status = 'completed', completed_at = now()
  where p.id = completed.id
  returning p.* into completed;

  update public.profiles
  set completed_pickups = completed_pickups + 1
  where id = completed.dealer_id;

  insert into public.wallet_transactions (
    pickup_id, payer_id, payee_id, amount_paise, platform_fee_paise,
    status, transaction_type, note, paid_at
  ) values (
    completed.id, completed.dealer_id, completed.customer_id, amount_paise, 0,
    'paid', 'pickup_wallet_payment', 'Pickup payment confirmed by customer', now()
  );

  insert into public.notifications (user_id, title, body)
  values (completed.customer_id, 'Pickup payment received', 'The dealer sent ' || chr(8377) || (amount_paise::numeric / 100)::text || ' to your app wallet.');
  insert into public.notifications (user_id, title, body)
  values (completed.dealer_id, 'Pickup paid from wallet', 'Your wallet was charged ' || chr(8377) || (amount_paise::numeric / 100)::text || ' for the completed pickup.');

  return completed;
end;
$$;

revoke all on function public.confirm_pickup_completion(uuid) from public, anon;
grant execute on function public.confirm_pickup_completion(uuid) to authenticated;

-- Keep the same lock order as confirmation for legacy completed pickups:
-- pickup row first, dealer profile second.
create or replace function public.pay_completed_pickup_from_wallet(request_id uuid)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  dealer_id uuid := (select auth.uid());
  pickup public.pickup_requests;
  amount_paise bigint;
  dealer_balance_paise bigint;
  existing public.wallet_transactions;
  result public.wallet_transactions;
begin
  if dealer_id is null or not public.is_verified_dealer() then
    raise exception 'Verified dealer access required' using errcode = '42501';
  end if;
  select * into pickup from public.pickup_requests p
  where p.id = request_id and p.dealer_id = dealer_id and p.status = 'completed'
  for update;
  if pickup.id is null or pickup.final_amount is null or pickup.final_amount <= 0 then
    raise exception 'Completed pickup with a valid final amount not found' using errcode = 'P0002';
  end if;
  perform 1 from public.profiles where id = dealer_id for update;

  select * into existing from public.wallet_transactions t where t.pickup_id = request_id;
  if existing.id is not null then
    if existing.transaction_type = 'pickup_wallet_payment' and existing.status = 'paid' then return existing; end if;
    raise exception 'A payment is already recorded for this pickup' using errcode = '23505';
  end if;
  amount_paise := round(pickup.final_amount * 100)::bigint;
  select coalesce(sum(case
    when t.payee_id = dealer_id and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
      then t.amount_paise - t.platform_fee_paise
    when t.payer_id = dealer_id and t.transaction_type in ('wallet_transfer', 'pickup_wallet_payment')
      then -t.amount_paise
    else 0
  end), 0)::bigint into dealer_balance_paise
  from public.wallet_transactions t
  where t.status = 'paid'
    and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
    and (t.payee_id = dealer_id or t.payer_id = dealer_id);
  if dealer_balance_paise < amount_paise then
    raise exception 'Insufficient wallet balance for this pickup payment' using errcode = 'P0001';
  end if;

  insert into public.wallet_transactions (
    pickup_id, payer_id, payee_id, amount_paise, platform_fee_paise,
    status, transaction_type, note, paid_at
  ) values (
    request_id, dealer_id, pickup.customer_id, amount_paise, 0,
    'paid', 'pickup_wallet_payment', 'Pickup payment', now()
  ) returning * into result;
  insert into public.notifications (user_id, title, body)
  values (pickup.customer_id, 'Pickup payment received', 'The dealer sent ' || chr(8377) || (amount_paise::numeric / 100)::text || ' to your app wallet.');
  return result;
end;
$$;

revoke all on function public.pay_completed_pickup_from_wallet(uuid) from public, anon;
grant execute on function public.pay_completed_pickup_from_wallet(uuid) to authenticated;
