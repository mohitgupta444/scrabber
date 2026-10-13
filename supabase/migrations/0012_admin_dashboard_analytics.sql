create or replace function public.admin_dashboard_analytics()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users', (select count(*) from public.profiles p where p.role = 'user'),
    'dealers', (select count(*) from public.profiles p where p.role = 'dealer'),
    'verifiedDealers', (select count(*) from public.profiles p where p.role = 'dealer' and p.verified),
    'pendingDealers', (select count(*) from public.profiles p where p.role = 'dealer' and p.verification_status = 'pending'),
    'totalPickups', (select count(*) from public.pickup_requests),
    'activePickups', (select count(*) from public.pickup_requests p where p.status in ('accepted', 'on_the_way', 'arrived', 'weighing', 'awaiting_confirmation')),
    'completedPickups', (select count(*) from public.pickup_requests p where p.status = 'completed'),
    'pickupsThisMonth', (select count(*) from public.pickup_requests p where p.created_at >= date_trunc('month', now())),
    'grossTransactionValue', coalesce((select sum(p.final_amount) from public.pickup_requests p where p.status = 'completed'), 0),
    'estimatedPlatformCommission', coalesce((select sum(p.final_amount) * 0.05 from public.pickup_requests p where p.status = 'completed'), 0),
    'monthly', (
      select coalesce(jsonb_agg(month_data order by month_start), '[]'::jsonb)
      from (
        select
          months.month_start,
          jsonb_build_object(
            'label', to_char(months.month_start, 'Mon'),
            'requests', count(p.id),
            'completed', count(p.id) filter (where p.status = 'completed'),
            'amount', coalesce(sum(p.final_amount) filter (where p.status = 'completed'), 0)
          ) as month_data
        from generate_series(
          date_trunc('month', now()) - interval '5 months',
          date_trunc('month', now()),
          interval '1 month'
        ) as months(month_start)
        left join public.pickup_requests p
          on p.created_at >= months.month_start
          and p.created_at < months.month_start + interval '1 month'
        group by months.month_start
      ) monthly_rows
    ),
    'statuses', (
      select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', total) order by total desc), '[]'::jsonb)
      from (
        select p.status::text as status, count(*) as total
        from public.pickup_requests p
        group by p.status
      ) status_rows
    ),
    'categories', (
      select coalesce(jsonb_agg(jsonb_build_object('category', category, 'count', total) order by total desc), '[]'::jsonb)
      from (
        select p.category, count(*) as total
        from public.pickup_requests p
        group by p.category
        order by total desc
        limit 6
      ) category_rows
    ),
    'recentPickups', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', recent.id,
        'category', recent.category,
        'status', recent.status,
        'created_at', recent.created_at,
        'final_amount', recent.final_amount,
        'customer_name', customer.full_name,
        'dealer_name', dealer.business_name
      ) order by recent.created_at desc), '[]'::jsonb)
      from (
        select p.id, p.category, p.status, p.created_at, p.final_amount, p.customer_id, p.dealer_id
        from public.pickup_requests p
        order by p.created_at desc
        limit 8
      ) recent
      left join public.profiles customer on customer.id = recent.customer_id
      left join public.profiles dealer on dealer.id = recent.dealer_id
    )
  );
end;
$$;

revoke all on function public.admin_dashboard_analytics() from public, anon;
grant execute on function public.admin_dashboard_analytics() to authenticated;
