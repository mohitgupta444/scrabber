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
  where p.id = request_id and p.customer_id = customer_actor
  for update;

  if completed.id is null then
    raise exception 'Pickup not found' using errcode = 'P0002';
  end if;

  -- A retry after a successful commit returns the original result; it never
  -- inserts or charges a second wallet transaction.
  if completed.status = 'completed' then
    select * into existing_payment
    from public.wallet_transactions t
    where t.pickup_id = completed.id
      and t.transaction_type = 'pickup_wallet_payment'
      and t.status = 'paid'
      and t.payer_id = completed.dealer_id
      and t.payee_id = completed.customer_id;
    if existing_payment.id is not null then return completed; end if;
    raise exception 'Pickup is completed but its wallet payment is not recorded' using errcode = 'P0002';
  end if;

  if completed.status <> 'awaiting_confirmation' then
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
