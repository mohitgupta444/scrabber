-- Tighten public profile visibility, add terminal pickup actions, and move
-- aggregate/location queries to database functions.

drop policy if exists "Profiles visible to account owner, verified dealers, and admins" on public.profiles;
create index if not exists profiles_verified_dealer_latitude_idx
  on public.profiles (latitude)
  where role = 'dealer' and verified and verification_status = 'approved' and latitude is not null;

create policy "Profiles visible to owner, pickup participants, and admins"
on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or public.is_admin()
  or exists (
    select 1 from public.pickup_requests p
    where (p.dealer_id = profiles.id or p.customer_id = profiles.id)
      and (p.customer_id = (select auth.uid()) or p.dealer_id = (select auth.uid()))
  )
);

create or replace function public.get_public_dealer(target_dealer_id uuid)
returns table (
  id uuid, full_name text, business_name text, phone text, address text,
  latitude double precision, longitude double precision, rating numeric,
  completed_pickups integer, service_radius_km integer, verified boolean,
  scrap_categories text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.full_name, d.business_name, d.phone, d.address,
         d.latitude, d.longitude, d.rating, d.completed_pickups,
         d.service_radius_km, d.verified, d.scrap_categories
  from public.profiles d
  where d.id = target_dealer_id and d.role = 'dealer'
    and d.verified and d.verification_status = 'approved';
$$;

create or replace function public.get_nearby_dealers(search_latitude double precision, search_longitude double precision)
returns table (
  id uuid, full_name text, business_name text, phone text, address text,
  latitude double precision, longitude double precision, rating numeric,
  completed_pickups integer, service_radius_km integer, verified boolean,
  scrap_categories text[], distance_km double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in to find nearby dealers' using errcode = '42501';
  end if;
  if search_latitude is null or search_longitude is null
    or search_latitude not between -90 and 90
    or search_longitude not between -180 and 180 then
    raise exception 'Invalid map coordinates' using errcode = '22023';
  end if;
  return query
  select d.id, d.full_name, d.business_name, d.phone, d.address,
         d.latitude, d.longitude, d.rating, d.completed_pickups,
         d.service_radius_km, d.verified, d.scrap_categories,
         (2 * 6371 * asin(least(1, sqrt(
           sin(radians(search_latitude - d.latitude) / 2) ^ 2
           + cos(radians(d.latitude)) * cos(radians(search_latitude))
           * sin(radians(search_longitude - d.longitude) / 2) ^ 2
         ))))::double precision as distance_km
  from public.profiles d
  where d.role = 'dealer' and d.verified and d.verification_status = 'approved'
    and d.latitude is not null and d.longitude is not null
    and d.latitude between greatest(-90, search_latitude - 1)
      and least(90, search_latitude + 1)
    and (2 * 6371 * asin(least(1, sqrt(
      sin(radians(search_latitude - d.latitude) / 2) ^ 2
      + cos(radians(d.latitude)) * cos(radians(search_latitude))
      * sin(radians(search_longitude - d.longitude) / 2) ^ 2
    ))) <= d.service_radius_km)
  order by 13;
end;
$$;

create or replace function public.get_recent_reviews()
returns table (id uuid, rating smallint, review text, created_at timestamptz, business_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.rating, r.review, r.created_at, d.business_name
  from public.pickup_reviews r
  join public.profiles d on d.id = r.dealer_id
  where (select auth.uid()) is not null
  order by r.created_at desc
  limit 10;
$$;

create or replace function public.dealer_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  dealer_id uuid := (select auth.uid());
begin
  if not public.is_verified_dealer() then
    raise exception 'Verified dealer access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'totalEarnings', coalesce((select sum(p.final_amount) from public.pickup_requests p where p.dealer_id = dealer_id and p.status = 'completed'), 0),
    'completedPickups', (select count(*) from public.pickup_requests p where p.dealer_id = dealer_id and p.status = 'completed'),
    'averageTransaction', coalesce((select avg(p.final_amount) from public.pickup_requests p where p.dealer_id = dealer_id and p.status = 'completed'), 0)
  );
end;
$$;

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'users', (select count(*) from public.profiles where role = 'user'),
    'dealers', (select count(*) from public.profiles where role = 'dealer'),
    'verifiedDealers', (select count(*) from public.profiles where role = 'dealer' and verified),
    'totalPickups', (select count(*) from public.pickup_requests),
    'completedPickups', (select count(*) from public.pickup_requests where status = 'completed'),
    'grossTransactionValue', coalesce((select sum(final_amount) from public.pickup_requests where status = 'completed'), 0),
    'estimatedPlatformCommission', coalesce((select sum(final_amount) * 0.05 from public.pickup_requests where status = 'completed'), 0)
  );
end;
$$;

create or replace function public.cancel_pickup_request(request_id uuid)
returns public.pickup_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  cancelled public.pickup_requests;
begin
  update public.pickup_requests p
  set status = 'cancelled'
  where p.id = request_id and p.customer_id = (select auth.uid())
    and p.status = 'requested' and p.dealer_id is null
  returning p.* into cancelled;
  if cancelled.id is null then
    raise exception 'Only an unassigned pickup request can be cancelled by the customer' using errcode = 'P0002';
  end if;
  return cancelled;
end;
$$;

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
    update public.pickup_requests set status = 'cancelled' where id = request_id returning * into current_request;
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
  if next_status = 'awaiting_confirmation' and (measured_weight is null or measured_weight <= 0 or agreed_amount is null or agreed_amount < 0) then
    raise exception 'Actual weight and final amount are required for customer confirmation' using errcode = '22023';
  end if;
  update public.pickup_requests
  set status = next_status,
      actual_weight = case when next_status = 'awaiting_confirmation' then measured_weight else actual_weight end,
      final_amount = case when next_status = 'awaiting_confirmation' then agreed_amount else final_amount end
  where id = request_id returning * into current_request;
  if next_status = 'awaiting_confirmation' then
    insert into public.notifications (user_id, title, body)
    values (current_request.customer_id, 'Pickup amount ready to confirm',
      'The dealer entered ' || current_request.actual_weight::text || ' kg and ₹' || current_request.final_amount::text || '. Review the details in your pickup.');
  end if;
  return current_request;
end;
$$;

drop policy if exists "Pickup participants read messages" on public.pickup_messages;
drop policy if exists "Pickup participants send messages" on public.pickup_messages;
create policy "Active pickup participants read messages"
on public.pickup_messages for select to authenticated
using (
  exists (select 1 from public.pickup_requests p where p.id = pickup_id
    and p.status not in ('completed', 'cancelled', 'rejected')
    and (p.customer_id = (select auth.uid()) or p.dealer_id = (select auth.uid())))
);
create policy "Active pickup participants send messages"
on public.pickup_messages for insert to authenticated
with check (
  sender_id = (select auth.uid()) and exists (
    select 1 from public.pickup_requests p where p.id = pickup_id
      and p.status not in ('completed', 'cancelled', 'rejected')
      and (p.customer_id = (select auth.uid()) or p.dealer_id = (select auth.uid())))
);

create policy "Customers delete terminal pickup photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'pickup-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (select 1 from public.pickup_requests p
    where p.customer_id = (select auth.uid()) and p.status in ('completed', 'cancelled')
      and p.photo_urls @> array[name])
);

create or replace function public.clear_terminal_pickup_photo_refs(request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.pickup_requests p
    where p.id = request_id and p.customer_id = (select auth.uid())
      and p.status in ('completed', 'cancelled')) then
    raise exception 'Terminal pickup not found' using errcode = 'P0002';
  end if;
  update public.pickup_requests p
  set photo_urls = '{}'
  where p.id = request_id and p.customer_id = (select auth.uid())
    and p.status in ('completed', 'cancelled');
end;
$$;

grant execute on function public.get_public_dealer(uuid) to authenticated;
grant execute on function public.get_nearby_dealers(double precision, double precision) to authenticated;
grant execute on function public.get_recent_reviews() to authenticated;
grant execute on function public.dealer_dashboard_stats() to authenticated;
grant execute on function public.cancel_pickup_request(uuid) to authenticated;
grant execute on function public.clear_terminal_pickup_photo_refs(uuid) to authenticated;
revoke all on function public.get_public_dealer(uuid) from public, anon;
revoke all on function public.get_nearby_dealers(double precision, double precision) from public, anon;
revoke all on function public.get_recent_reviews() from public, anon;
revoke all on function public.dealer_dashboard_stats() from public, anon;
revoke all on function public.cancel_pickup_request(uuid) from public, anon;
revoke all on function public.clear_terminal_pickup_photo_refs(uuid) from public, anon;
