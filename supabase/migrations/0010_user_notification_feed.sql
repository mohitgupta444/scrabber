-- Include notifications in Supabase Realtime so the badge and feed update
-- immediately when database functions create a notification.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;

create or replace function public.notify_customer_pickup_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  notification_title text;
  notification_body text;
begin
  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, title, body)
    values (
      new.customer_id,
      'Pickup request received',
      'Your ' || new.category || ' pickup request has been sent to verified dealers.'
    );
    return new;
  end if;

  if old.status is not distinct from new.status then
    return new;
  end if;

  -- Acceptance, amount confirmation, completion, and dealer cancellation
  -- already create their own more detailed notifications in their RPCs.
  case new.status
    when 'on_the_way' then
      notification_title := 'Dealer on the way';
      notification_body := 'Your dealer is on the way for the ' || new.category || ' pickup.';
    when 'arrived' then
      notification_title := 'Dealer arrived';
      notification_body := 'Your dealer has arrived for the ' || new.category || ' pickup.';
    when 'weighing' then
      notification_title := 'Pickup weighing started';
      notification_body := 'The dealer has started weighing your ' || new.category || ' pickup.';
    else
      return new;
  end case;

  insert into public.notifications (user_id, title, body)
  values (new.customer_id, notification_title, notification_body);
  return new;
end;
$$;

drop trigger if exists notify_customer_pickup_activity on public.pickup_requests;
create trigger notify_customer_pickup_activity
after insert or update of status on public.pickup_requests
for each row execute function public.notify_customer_pickup_activity();

-- Seed a readable status item for existing customer pickups that predate the
-- notification feed, without adding the same summary twice if rerun manually.
insert into public.notifications (user_id, title, body, created_at)
select
  p.customer_id,
  'Pickup status update',
  'Pickup ' || upper(left(p.id::text, 8)) || ' is currently ' || replace(p.status::text, '_', ' ') || '.',
  coalesce(p.completed_at, p.updated_at, p.created_at)
from public.pickup_requests p
where not exists (
  select 1 from public.notifications n
  where n.user_id = p.customer_id
    and n.title = 'Pickup status update'
    and n.body = 'Pickup ' || upper(left(p.id::text, 8)) || ' is currently ' || replace(p.status::text, '_', ' ') || '.'
);

revoke all on function public.notify_customer_pickup_activity() from public, anon, authenticated;
