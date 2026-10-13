alter table public.wallet_transactions
  drop constraint wallet_transactions_transaction_type_check;
alter table public.wallet_transactions
  add constraint wallet_transactions_transaction_type_check
  check (transaction_type in ('pickup_payment', 'pickup_wallet_payment', 'wallet_transfer', 'admin_credit'));

create or replace function public.transfer_wallet_to_email(
  recipient_email text,
  transfer_amount_paise bigint,
  transfer_note text,
  transfer_idempotency_key uuid
)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  sender uuid := (select auth.uid());
  recipient uuid;
  available_paise bigint;
  result public.wallet_transactions;
begin
  if sender is null then
    raise exception 'Sign in to transfer wallet funds' using errcode = '42501';
  end if;
  if transfer_amount_paise is null or transfer_amount_paise <= 0 or transfer_amount_paise > 1000000000 then
    raise exception 'Enter a valid transfer amount' using errcode = '22023';
  end if;
  if transfer_note is not null and char_length(transfer_note) > 140 then
    raise exception 'Transfer note is too long' using errcode = '22023';
  end if;
  if recipient_email is null or length(trim(recipient_email)) = 0 or transfer_idempotency_key is null then
    raise exception 'Recipient email and transfer ID are required' using errcode = '22023';
  end if;

  perform 1 from public.profiles where id = sender for update;
  if not exists (select 1 from public.profiles where id = sender and role in ('user', 'dealer')) then
    raise exception 'Wallet transfers are not available for this account' using errcode = '42501';
  end if;
  select p.id into recipient from auth.users u join public.profiles p on p.id = u.id
  where lower(u.email) = lower(trim(recipient_email)) and p.role in ('user', 'dealer');
  if recipient is null or recipient = sender then
    raise exception 'Recipient account was not found' using errcode = 'P0002';
  end if;

  select coalesce(sum(case
    when t.payee_id = sender and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
      then t.amount_paise - t.platform_fee_paise
    when t.payer_id = sender and t.transaction_type in ('wallet_transfer', 'pickup_wallet_payment')
      then -t.amount_paise
    else 0
  end), 0)::bigint into available_paise
  from public.wallet_transactions t
  where t.status = 'paid'
    and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
    and (t.payee_id = sender or t.payer_id = sender);
  if available_paise < transfer_amount_paise then
    raise exception 'Insufficient wallet balance' using errcode = 'P0001';
  end if;

  insert into public.wallet_transactions (
    pickup_id, payer_id, payee_id, amount_paise, platform_fee_paise,
    status, transaction_type, note, idempotency_key, paid_at
  ) values (
    null, sender, recipient, transfer_amount_paise, 0,
    'paid', 'wallet_transfer', nullif(trim(transfer_note), ''), transfer_idempotency_key, now()
  ) returning * into result;
  insert into public.notifications (user_id, title, body)
  values (recipient, 'Wallet transfer received', 'You received ' || chr(8377) || (transfer_amount_paise::numeric / 100)::text || ' in your app wallet.');
  return result;
exception
  when unique_violation then
    select * into result from public.wallet_transactions
    where idempotency_key = transfer_idempotency_key and payer_id = sender
      and payee_id = recipient and amount_paise = transfer_amount_paise;
    if result.id is null then raise; end if;
    return result;
end;
$$;

revoke all on function public.transfer_wallet_to_email(text, bigint, text, uuid) from public, anon;
grant execute on function public.transfer_wallet_to_email(text, bigint, text, uuid) to authenticated;

create or replace function public.pay_completed_pickup_from_wallet(request_id uuid)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  dealer_id uuid := (select auth.uid());
  customer_id uuid;
  final_amount numeric;
  amount_paise bigint;
  available_paise bigint;
  existing public.wallet_transactions;
  result public.wallet_transactions;
begin
  if dealer_id is null or not public.is_verified_dealer() then
    raise exception 'Verified dealer access required' using errcode = '42501';
  end if;

  perform 1 from public.profiles where id = dealer_id for update;
  select p.customer_id, p.final_amount into customer_id, final_amount
  from public.pickup_requests p
  where p.id = request_id and p.dealer_id = dealer_id and p.status = 'completed'
  for update;
  if customer_id is null or final_amount is null or final_amount <= 0 then
    raise exception 'Completed pickup with a valid final amount not found' using errcode = 'P0002';
  end if;

  select * into existing from public.wallet_transactions t where t.pickup_id = request_id;
  if existing.id is not null then
    if existing.transaction_type = 'pickup_wallet_payment' and existing.status = 'paid' then
      return existing;
    end if;
    raise exception 'A payment is already recorded for this pickup' using errcode = '23505';
  end if;

  amount_paise := round(final_amount * 100)::bigint;
  select coalesce(sum(case
    when t.payee_id = dealer_id and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
      then t.amount_paise - t.platform_fee_paise
    when t.payer_id = dealer_id and t.transaction_type in ('wallet_transfer', 'pickup_wallet_payment')
      then -t.amount_paise
    else 0
  end), 0)::bigint
  into available_paise
  from public.wallet_transactions t
  where t.status = 'paid'
    and t.transaction_type in ('wallet_transfer', 'admin_credit', 'pickup_wallet_payment')
    and (t.payee_id = dealer_id or t.payer_id = dealer_id);

  if available_paise < amount_paise then
    raise exception 'Insufficient wallet balance for this pickup payment' using errcode = 'P0001';
  end if;

  insert into public.wallet_transactions (
    pickup_id, payer_id, payee_id, amount_paise, platform_fee_paise,
    status, transaction_type, note, paid_at
  ) values (
    request_id, dealer_id, customer_id, amount_paise, 0,
    'paid', 'pickup_wallet_payment', 'Pickup payment', now()
  ) returning * into result;

  insert into public.notifications (user_id, title, body)
  values (customer_id, 'Pickup payment received', 'The dealer sent ' || chr(8377) || (amount_paise::numeric / 100)::text || ' to your app wallet.');
  return result;
end;
$$;

revoke all on function public.pay_completed_pickup_from_wallet(uuid) from public, anon;
grant execute on function public.pay_completed_pickup_from_wallet(uuid) to authenticated;
