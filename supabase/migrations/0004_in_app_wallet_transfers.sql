alter table public.wallet_transactions
  alter column pickup_id drop not null,
  add column transaction_type text not null default 'pickup_payment'
    check (transaction_type in ('pickup_payment', 'wallet_transfer', 'admin_credit')),
  add column note text check (note is null or char_length(note) <= 140),
  add column idempotency_key uuid unique;

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
  if transfer_amount_paise is null or transfer_amount_paise <= 0
    or transfer_amount_paise > 1000000000 then
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
  select p.id into recipient
  from auth.users u
  join public.profiles p on p.id = u.id
  where lower(u.email) = lower(trim(recipient_email))
    and p.role in ('user', 'dealer');
  if recipient is null or recipient = sender then
    raise exception 'Recipient account was not found' using errcode = 'P0002';
  end if;

  select coalesce(sum(case
    when t.payee_id = sender and t.transaction_type in ('wallet_transfer', 'admin_credit')
      then t.amount_paise - t.platform_fee_paise
    when t.payer_id = sender and t.transaction_type = 'wallet_transfer'
      then -t.amount_paise
    else 0
  end), 0)::bigint
  into available_paise
  from public.wallet_transactions t
  where t.status = 'paid'
    and t.transaction_type in ('wallet_transfer', 'admin_credit')
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

create or replace function public.admin_credit_wallet_to_email(
  recipient_email text,
  credit_amount_paise bigint,
  credit_note text,
  credit_idempotency_key uuid
)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_id uuid := (select auth.uid());
  recipient uuid;
  result public.wallet_transactions;
begin
  if admin_id is null or not public.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if credit_amount_paise is null or credit_amount_paise <= 0
    or credit_amount_paise > 1000000000
    or credit_note is null or length(trim(credit_note)) < 4
    or length(credit_note) > 140 or credit_idempotency_key is null then
    raise exception 'Enter a valid credit amount, reason, and request ID' using errcode = '22023';
  end if;
  select p.id into recipient
  from auth.users u join public.profiles p on p.id = u.id
  where lower(u.email) = lower(trim(recipient_email)) and p.role in ('user', 'dealer');
  if recipient is null then
    raise exception 'Recipient account was not found' using errcode = 'P0002';
  end if;
  insert into public.wallet_transactions (
    pickup_id, payer_id, payee_id, amount_paise, platform_fee_paise,
    status, transaction_type, note, idempotency_key, paid_at
  ) values (
    null, admin_id, recipient, credit_amount_paise, 0,
    'paid', 'admin_credit', trim(credit_note), credit_idempotency_key, now()
  ) returning * into result;
  insert into public.notifications (user_id, title, body)
  values (recipient, 'Wallet credit received', 'Your app wallet was credited ' || chr(8377) || (credit_amount_paise::numeric / 100)::text || '.');
  return result;
exception
  when unique_violation then
    select * into result from public.wallet_transactions
      where idempotency_key = credit_idempotency_key and payer_id = admin_id
        and payee_id = recipient and amount_paise = credit_amount_paise
        and transaction_type = 'admin_credit';
    if result.id is null then raise; end if;
    return result;
end;
$$;

revoke all on function public.admin_credit_wallet_to_email(text, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_credit_wallet_to_email(text, bigint, text, uuid) to authenticated;
