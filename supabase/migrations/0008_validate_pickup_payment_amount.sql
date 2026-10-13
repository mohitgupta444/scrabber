-- Keep customer confirmation payable: store a positive INR amount with the
-- same two-decimal precision used by the wallet ledger (paise).
create or replace function public.advance_pickup_status(
  request_id uuid,
  next_status public.pickup_status,
  measured_weight numeric default null,
  agreed_amount numeric default null
)
returns public.pickup_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_request public.pickup_requests;
  expected_next public.pickup_status;
  rounded_amount numeric;
begin
  select * into current_request from public.pickup_requests
  where id = request_id and dealer_id = (select auth.uid()) for update;
  if current_request.id is null then
    raise exception 'Pickup not found or not assigned to you' using errcode = '42501';
  end if;

  if next_status = 'cancelled' then
    if current_request.status not in ('accepted', 'on_the_way', 'arrived', 'weighing') then
      raise exception 'This pickup can no longer be cancelled by the dealer' using errcode = '22023';
    end if;
    update public.pickup_requests set status = 'cancelled'
    where id = request_id returning * into current_request;
    insert into public.notifications (user_id, title, body)
    values (current_request.customer_id, 'Pickup cancelled by dealer', 'Your assigned dealer cancelled this pickup.');
    return current_request;
  end if;

  expected_next := case current_request.status
    when 'accepted' then 'on_the_way'::public.pickup_status
    when 'on_the_way' then 'arrived'::public.pickup_status
    when 'arrived' then 'weighing'::public.pickup_status
    when 'weighing' then 'awaiting_confirmation'::public.pickup_status
    else null
  end;
  if expected_next is distinct from next_status then
    raise exception 'Invalid pickup status transition' using errcode = '22023';
  end if;

  if next_status = 'awaiting_confirmation' then
    if measured_weight is null or measured_weight <= 0
      or agreed_amount is null or agreed_amount <= 0
      or agreed_amount > 10000000 then
      raise exception 'Enter a positive weight and an amount from 0.01 to 10000000' using errcode = '22023';
    end if;
    rounded_amount := round(agreed_amount, 2);
    if rounded_amount <= 0 then
      raise exception 'Final amount must be at least 0.01' using errcode = '22023';
    end if;
  end if;

  update public.pickup_requests
  set status = next_status,
      actual_weight = case when next_status = 'awaiting_confirmation' then measured_weight else actual_weight end,
      final_amount = case when next_status = 'awaiting_confirmation' then rounded_amount else final_amount end
  where id = request_id returning * into current_request;

  if next_status = 'awaiting_confirmation' then
    insert into public.notifications (user_id, title, body)
    values (current_request.customer_id, 'Pickup amount ready to confirm',
      'The dealer entered ' || current_request.actual_weight::text || ' kg and ₹' || current_request.final_amount::text || '. Review the details in your pickup.');
  end if;
  return current_request;
end;
$$;

revoke all on function public.advance_pickup_status(uuid, public.pickup_status, numeric, numeric) from public, anon;
grant execute on function public.advance_pickup_status(uuid, public.pickup_status, numeric, numeric) to authenticated;
