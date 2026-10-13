create extension if not exists pgcrypto;

create type public.account_role as enum ('user', 'dealer', 'admin');
create type public.pickup_status as enum (
  'requested',
  'accepted',
  'on_the_way',
  'arrived',
  'weighing',
  'awaiting_confirmation',
  'completed',
  'cancelled',
  'rejected'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.account_role not null default 'user',
  full_name text not null,
  phone text,
  business_name text,
  address text,
  latitude double precision,
  longitude double precision,
  service_radius_km integer not null default 8 check (service_radius_km between 1 and 100),
  scrap_categories text[] not null default '{}',
  verified boolean not null default false,
  verification_status text not null default 'pending' check (verification_status in ('pending', 'approved', 'rejected')),
  rating numeric(2, 1) not null default 0 check (rating between 0 and 5),
  completed_pickups integer not null default 0 check (completed_pickups >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dealer_business_name_required check (role <> 'dealer' or business_name is not null)
);

create table public.scrap_prices (
  category text primary key,
  price_per_kg numeric(10, 2) not null check (price_per_kg >= 0),
  currency text not null default 'INR',
  updated_at timestamptz not null default now()
);

insert into public.scrap_prices (category, price_per_kg) values
  ('Newspaper', 12), ('Cardboard', 15), ('Paper', 11), ('Plastic', 8),
  ('Iron', 24), ('Steel', 28), ('Aluminium', 115), ('Copper', 420),
  ('E-waste', 72), ('Appliances', 36), ('Furniture', 18),
  ('Mixed Scrap', 16), ('Other', 10)
on conflict (category) do nothing;

create table public.pickup_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  dealer_id uuid references public.profiles(id) on delete restrict,
  category text not null,
  quantity numeric(10, 2) not null check (quantity > 0),
  unit text not null check (unit in ('kg', 'pieces', 'approx')),
  address text not null,
  house_flat text,
  landmark text,
  contact_phone text,
  pickup_time text not null,
  estimated_value numeric(10, 2) not null check (estimated_value >= 0),
  actual_weight numeric(10, 2) check (actual_weight > 0),
  final_amount numeric(10, 2) check (final_amount >= 0),
  latitude double precision not null,
  longitude double precision not null,
  photo_urls text[] not null default '{}',
  status public.pickup_status not null default 'requested',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  completed_at timestamptz
);

create index pickup_requests_customer_created_idx
  on public.pickup_requests (customer_id, created_at desc);
create index pickup_requests_dealer_created_idx
  on public.pickup_requests (dealer_id, created_at desc);
create index pickup_requests_open_idx
  on public.pickup_requests (created_at desc) where status = 'requested';

create table public.pickup_messages (
  id uuid primary key default gen_random_uuid(),
  pickup_id uuid not null references public.pickup_requests(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index pickup_messages_pickup_created_idx
  on public.pickup_messages (pickup_id, created_at);

create table public.pickup_declines (
  pickup_id uuid not null references public.pickup_requests(id) on delete cascade,
  dealer_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (pickup_id, dealer_id)
);

create or replace function public.is_dealer_eligible_for_pickup(target_dealer_id uuid, target_pickup_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles d
    join public.pickup_requests p on p.id = target_pickup_id
    where d.id = target_dealer_id
      and d.role = 'dealer'
      and d.verified
      and d.latitude is not null
      and d.longitude is not null
      and (
        cardinality(d.scrap_categories) = 0
        or p.category = any(d.scrap_categories)
      )
      and 2 * 6371 * asin(least(1, sqrt(
        sin(radians(p.latitude - d.latitude) / 2) ^ 2
        + cos(radians(d.latitude)) * cos(radians(p.latitude))
        * sin(radians(p.longitude - d.longitude) / 2) ^ 2
      ))) <= d.service_radius_km
  );
$$;

create or replace function public.notify_nearby_dealers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  dealer_record record;
begin
  for dealer_record in
    select d.id
    from public.profiles d
    where d.role = 'dealer'
      and d.verified
      and d.latitude is not null
      and d.longitude is not null
      and (
        cardinality(d.scrap_categories) = 0
        or new.category = any(d.scrap_categories)
      )
      and 2 * 6371 * asin(least(1, sqrt(
        sin(radians(new.latitude - d.latitude) / 2) ^ 2
        + cos(radians(d.latitude)) * cos(radians(new.latitude))
        * sin(radians(new.longitude - d.longitude) / 2) ^ 2
      ))) <= d.service_radius_km
  loop
    insert into public.notifications (user_id, title, body)
    values (
      dealer_record.id,
      'Nearby pickup request',
      'A customer nearby requested pickup for ' || new.category || '.'
    );
  end loop;
  return new;
end;
$$;

create trigger pickup_requests_notify_nearby_dealers
after insert on public.pickup_requests
for each row execute function public.notify_nearby_dealers();

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

create table public.pickup_reviews (
  id uuid primary key default gen_random_uuid(),
  pickup_id uuid not null unique references public.pickup_requests(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id) on delete restrict,
  dealer_id uuid not null references public.profiles(id) on delete restrict,
  rating smallint not null check (rating between 1 and 5),
  review text not null default '' check (char_length(review) <= 2000),
  created_at timestamptz not null default now()
);

create index pickup_reviews_dealer_created_idx
  on public.pickup_reviews (dealer_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.update_dealer_rating()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set rating = (
    select round(avg(rating)::numeric, 1)
    from public.pickup_reviews
    where dealer_id = new.dealer_id
  )
  where id = new.dealer_id;
  return new;
end;
$$;

create trigger pickup_reviews_update_dealer_rating
after insert on public.pickup_reviews
for each row execute function public.update_dealer_rating();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger pickup_requests_set_updated_at
before update on public.pickup_requests
for each row execute function public.set_updated_at();

create or replace function public.calculate_pickup_estimate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rate numeric(10, 2);
  unit_factor numeric(4, 2);
begin
  select price_per_kg into rate
  from public.scrap_prices
  where category = new.category;
  if rate is null then
    raise exception 'No current price configured for category %', new.category using errcode = '22023';
  end if;
  unit_factor := case new.unit when 'pieces' then 0.4 when 'approx' then 0.9 else 1 end;
  new.estimated_value := round(rate * new.quantity * unit_factor, 2);
  return new;
end;
$$;

create trigger pickup_requests_calculate_estimate
before insert on public.pickup_requests
for each row execute function public.calculate_pickup_estimate();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_role text;
begin
  requested_role := coalesce(new.raw_user_meta_data ->> 'role', 'user');
  if requested_role not in ('user', 'dealer') then
    requested_role := 'user';
  end if;

  insert into public.profiles (id, role, full_name, phone, business_name, verification_status)
  values (
    new.id,
    requested_role::public.account_role,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    case when requested_role = 'dealer'
      then coalesce(nullif(new.raw_user_meta_data ->> 'business_name', ''), 'Dealer shop')
      else null
    end,
    case when requested_role = 'dealer' then 'pending' else 'approved' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

create or replace function public.is_verified_dealer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'dealer' and verified
  );
$$;

create or replace function public.is_pickup_participant(target_pickup_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.pickup_requests
    where id = target_pickup_id
      and ((customer_id = (select auth.uid())) or (dealer_id = (select auth.uid())))
  );
$$;

create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and (select auth.uid()) = old.id then
    new.role := old.role;
    new.verified := old.verified;
    new.rating := old.rating;
    new.completed_pickups := old.completed_pickups;
    new.verification_status := old.verification_status;
  end if;
  return new;
end;
$$;

create trigger profiles_protect_system_fields
before update on public.profiles
for each row execute function public.protect_profile_role();

create or replace function public.accept_pickup_request(request_id uuid)
returns public.pickup_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  accepted public.pickup_requests;
begin
  if not public.is_verified_dealer() then
    raise exception 'Only verified dealers can accept pickup requests' using errcode = '42501';
  end if;

  update public.pickup_requests
  set dealer_id = (select auth.uid()),
      status = 'accepted',
      accepted_at = now()
  where id = request_id
    and status = 'requested'
    and dealer_id is null
    and public.is_dealer_eligible_for_pickup((select auth.uid()), id)
  returning * into accepted;

  if accepted.id is null then
    raise exception 'This pickup request is no longer available' using errcode = 'P0002';
  end if;

  insert into public.notifications (user_id, title, body)
  values (
    accepted.customer_id,
    'Pickup accepted',
    'A verified local dealer accepted your pickup request.'
  );
  return accepted;
end;
$$;

create or replace function public.get_open_pickup_requests()
returns table (
  id uuid,
  category text,
  quantity numeric,
  unit text,
  estimated_value numeric,
  pickup_time text,
  created_at timestamptz,
  approximate_area text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_verified_dealer() then
    raise exception 'Only verified dealers can view open pickup requests' using errcode = '42501';
  end if;

  return query
  select p.id, p.category, p.quantity, p.unit, p.estimated_value,
         p.pickup_time, p.created_at, 'Approximate area shared after acceptance'::text
  from public.pickup_requests p
  where p.status = 'requested' and p.dealer_id is null
    and public.is_dealer_eligible_for_pickup((select auth.uid()), p.id)
    and not exists (
      select 1 from public.pickup_declines d
      where d.pickup_id = p.id and d.dealer_id = (select auth.uid())
    )
  order by p.created_at asc;
end;
$$;

create or replace function public.reject_pickup_request(request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_verified_dealer() then
    raise exception 'Only verified dealers can reject pickup requests' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.pickup_requests
    where id = request_id and status = 'requested' and dealer_id is null
  ) or not public.is_dealer_eligible_for_pickup((select auth.uid()), request_id) then
    raise exception 'This pickup request is no longer available' using errcode = 'P0002';
  end if;
  insert into public.pickup_declines (pickup_id, dealer_id)
  values (request_id, (select auth.uid()))
  on conflict do nothing;
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
  select * into current_request
  from public.pickup_requests
  where id = request_id and dealer_id = (select auth.uid())
  for update;
  if current_request.id is null then
    raise exception 'Pickup not found or not assigned to you' using errcode = '42501';
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
  where id = request_id
  returning * into current_request;

  if next_status = 'awaiting_confirmation' then
    insert into public.notifications (user_id, title, body)
    values (
      current_request.customer_id,
      'Pickup amount ready to confirm',
      'The dealer entered ' || current_request.actual_weight::text || ' kg and ₹' || current_request.final_amount::text || '. Review the details in your pickup.'
    );
  end if;
  return current_request;
end;
$$;

create or replace function public.confirm_pickup_completion(request_id uuid)
returns public.pickup_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed public.pickup_requests;
begin
  update public.pickup_requests
  set status = 'completed',
      completed_at = now()
  where id = request_id
    and customer_id = (select auth.uid())
    and status = 'awaiting_confirmation'
  returning * into completed;

  if completed.id is null then
    raise exception 'Pickup is not waiting for your confirmation' using errcode = 'P0002';
  end if;

  update public.profiles
  set completed_pickups = completed_pickups + 1
  where id = completed.dealer_id;

  insert into public.notifications (user_id, title, body)
  values (
    completed.dealer_id,
    'Pickup confirmed by customer',
    'The customer confirmed the pickup amount of ₹' || completed.final_amount::text || '.'
  );
  return completed;
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
    'platformCommission', coalesce((select sum(final_amount) * 0.05 from public.pickup_requests where status = 'completed'), 0),
    'revenue', coalesce((select sum(final_amount) * 0.05 from public.pickup_requests where status = 'completed'), 0)
  );
end;
$$;

alter table public.profiles enable row level security;
alter table public.scrap_prices enable row level security;
alter table public.pickup_requests enable row level security;
alter table public.pickup_messages enable row level security;
alter table public.notifications enable row level security;
alter table public.pickup_declines enable row level security;
alter table public.pickup_reviews enable row level security;

create policy "Profiles visible to account owner, verified dealers, and admins"
on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or (role = 'dealer' and verified)
  or public.is_admin()
  or exists (
    select 1 from public.pickup_requests p
    where (
      p.dealer_id = profiles.id
      and (p.customer_id = (select auth.uid()) or p.dealer_id = (select auth.uid()))
    ) or (
      p.customer_id = profiles.id
      and (p.customer_id = (select auth.uid()) or p.dealer_id = (select auth.uid()))
    )
  )
);

create policy "Users update their own profile"
on public.profiles for update to authenticated
using (id = (select auth.uid()) or public.is_admin())
with check (id = (select auth.uid()) or public.is_admin());

create policy "Authenticated users read scrap prices"
on public.scrap_prices for select to authenticated using (true);

create policy "Customers and assigned dealers read pickup details"
on public.pickup_requests for select to authenticated
using (
  customer_id = (select auth.uid())
  or dealer_id = (select auth.uid())
  or public.is_admin()
);

create policy "Customers create pickup requests"
on public.pickup_requests for insert to authenticated
with check (
  customer_id = (select auth.uid())
  and dealer_id is null
  and status = 'requested'
  and actual_weight is null
  and final_amount is null
  and accepted_at is null
  and completed_at is null
);

create policy "Pickup participants read messages"
on public.pickup_messages for select to authenticated
using (public.is_pickup_participant(pickup_id));

create policy "Pickup participants send messages"
on public.pickup_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and public.is_pickup_participant(pickup_id)
);

create policy "Users read their own notifications"
on public.notifications for select to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

create policy "Users mark their own notifications read"
on public.notifications for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "Authenticated users can read pickup reviews"
on public.pickup_reviews for select to authenticated using (true);

create policy "Customers review their own completed pickup once"
on public.pickup_reviews for insert to authenticated
with check (
  reviewer_id = (select auth.uid())
  and exists (
    select 1 from public.pickup_requests p
    where p.id = pickup_reviews.pickup_id
      and p.customer_id = (select auth.uid())
      and p.dealer_id = pickup_reviews.dealer_id
      and p.status = 'completed'
  )
);

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.scrap_prices to authenticated;
grant select, insert on public.pickup_requests to authenticated;
grant update (status, actual_weight, final_amount) on public.pickup_requests to authenticated;
grant select, insert on public.pickup_messages to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select, insert on public.pickup_reviews to authenticated;
grant execute on function public.accept_pickup_request(uuid) to authenticated;
grant execute on function public.get_open_pickup_requests() to authenticated;
grant execute on function public.reject_pickup_request(uuid) to authenticated;
grant execute on function public.advance_pickup_status(uuid, public.pickup_status, numeric, numeric) to authenticated;
grant execute on function public.confirm_pickup_completion(uuid) to authenticated;
grant execute on function public.admin_dashboard_stats() to authenticated;
grant execute on function public.is_pickup_participant(uuid) to authenticated;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.accept_pickup_request(uuid) from public, anon;
revoke all on function public.get_open_pickup_requests() from public, anon;
revoke all on function public.reject_pickup_request(uuid) from public, anon;
revoke all on function public.advance_pickup_status(uuid, public.pickup_status, numeric, numeric) from public, anon;
revoke all on function public.confirm_pickup_completion(uuid) from public, anon;
revoke all on function public.admin_dashboard_stats() from public, anon;
revoke all on function public.is_pickup_participant(uuid) from public, anon;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.is_verified_dealer() from public, anon;
revoke all on function public.is_dealer_eligible_for_pickup(uuid, uuid) from public, anon;
revoke all on function public.notify_nearby_dealers() from public, anon;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.calculate_pickup_estimate() from public, anon, authenticated;
revoke all on function public.protect_profile_role() from public, anon, authenticated;
revoke all on function public.update_dealer_rating() from public, anon, authenticated;
grant execute on function public.accept_pickup_request(uuid) to authenticated;
grant execute on function public.get_open_pickup_requests() to authenticated;
grant execute on function public.reject_pickup_request(uuid) to authenticated;
grant execute on function public.advance_pickup_status(uuid, public.pickup_status, numeric, numeric) to authenticated;
grant execute on function public.confirm_pickup_completion(uuid) to authenticated;
grant execute on function public.admin_dashboard_stats() to authenticated;
grant execute on function public.is_pickup_participant(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pickup-photos', 'pickup-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Users upload pickup photos to their own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'pickup-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "Pickup participants view pickup photos"
on storage.objects for select to authenticated
using (
  bucket_id = 'pickup-photos'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (
      select 1 from public.pickup_requests p
      where p.photo_urls @> array[name]
        and (p.customer_id = (select auth.uid()) or p.dealer_id = (select auth.uid()))
    )
  )
);

alter publication supabase_realtime add table public.pickup_requests;
alter publication supabase_realtime add table public.pickup_messages;
alter publication supabase_realtime add table public.profiles;
