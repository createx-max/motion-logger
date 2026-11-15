-- =====================================================================
--  Motion logger schema  (Supabase project: motion-logger,
--  ref aodrehuwkyhujkjvwjwr)
--  Already applied. Paste this ENTIRE file into Dashboard -> SQL Editor ->
--  New query -> Run to rebuild it in another project. Idempotent.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Devices
-- ---------------------------------------------------------------------
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  device_key   text not null unique,      -- long random secret the ESP32 sends
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Motion sessions (one row per light-on interval)
-- ---------------------------------------------------------------------
create table if not exists public.motion_sessions (
  id         bigint generated always as identity primary key,
  device_id  uuid not null references public.devices(id) on delete cascade,
  started_at timestamptz not null,
  ended_at   timestamptz,
  duration_s integer,
  created_at timestamptz not null default now()
);

create index if not exists motion_sessions_device_started_idx
  on public.motion_sessions (device_id, started_at desc);

-- at most one open (still running) session per device
create unique index if not exists motion_sessions_one_open_idx
  on public.motion_sessions (device_id) where ended_at is null;

-- duration is always derived, never trusted from the device
create or replace function public.motion_session_duration()
returns trigger
language plpgsql
as $$
begin
  if new.ended_at is null then
    new.duration_s := null;
  else
    new.duration_s := greatest(0, round(extract(epoch from (new.ended_at - new.started_at)))::int);
  end if;
  return new;
end;
$$;

drop trigger if exists motion_session_duration_trg on public.motion_sessions;
create trigger motion_session_duration_trg
  before insert or update on public.motion_sessions
  for each row execute function public.motion_session_duration();

-- ---------------------------------------------------------------------
-- 3. Ingest RPC - the only write path the device has
--    Called by the ESP32 as POST /rest/v1/rpc/motion_event
-- ---------------------------------------------------------------------
create or replace function public.motion_event(
  p_device_key text,
  p_event      text,                        -- 'start' | 'stop' | 'ping'
  p_ts         timestamptz default null     -- null -> server clock
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device uuid;
  v_ts     timestamptz := coalesce(p_ts, now());
  v_id     bigint;
begin
  select id into v_device from public.devices where device_key = p_device_key;

  if v_device is null then
    raise exception 'unknown device key' using errcode = '28000';
  end if;

  update public.devices set last_seen_at = now() where id = v_device;

  if p_event = 'start' then
    -- a session left open (reboot / Wi-Fi loss) is closed at the new start
    update public.motion_sessions
       set ended_at = v_ts
     where device_id = v_device
       and ended_at is null
       and started_at < v_ts;

    insert into public.motion_sessions (device_id, started_at)
    values (v_device, v_ts)
    returning id into v_id;

  elsif p_event = 'stop' then
    update public.motion_sessions
       set ended_at = v_ts
     where device_id = v_device
       and ended_at is null
       and started_at <= v_ts
    returning id into v_id;

    -- A heartbeat gap (or the stale-session cron) can close the row before the
    -- real stop arrives. Extend that recently closed interval instead of
    -- dropping the extra time.
    if v_id is null then
      update public.motion_sessions
         set ended_at = v_ts
       where id = (
         select id from public.motion_sessions
          where device_id = v_device
            and ended_at is not null
            and started_at <= v_ts
            and ended_at < v_ts
            and ended_at > v_ts - interval '15 minutes'
          order by started_at desc
          limit 1
       )
      returning id into v_id;
    end if;

  elsif p_event = 'ping' then
    v_id := null;   -- heartbeat: only refreshes devices.last_seen_at

  else
    raise exception 'unknown event %', p_event using errcode = '22023';
  end if;

  return v_id;
end;
$$;

revoke all on function public.motion_event(text, text, timestamptz) from public;
grant execute on function public.motion_event(text, text, timestamptz) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
alter table public.devices enable row level security;
alter table public.motion_sessions enable row level security;

drop policy if exists motion_sessions_read on public.motion_sessions;
create policy motion_sessions_read
  on public.motion_sessions
  for select to anon, authenticated
  using (true);

-- No insert/update/delete policy: writes can only go through motion_event(),
-- which validates the device key. devices has no policy at all, so the
-- device key can never be read with the publishable key. The dashboard reads
-- the safe columns through the view below.
create or replace view public.device_status as
  select id, name, last_seen_at from public.devices;

comment on view public.device_status is
  'Narrow, read-only view: exposes device name and last_seen_at, never device_key.';

grant select on public.device_status to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Realtime (live updates for the dashboard)
-- ---------------------------------------------------------------------
alter table public.motion_sessions replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'motion_sessions'
  ) then
    alter publication supabase_realtime add table public.motion_sessions;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. This device
-- ---------------------------------------------------------------------
insert into public.devices (name, device_key)
values ('ESP32 WROOM - PIR hallway', 'dev_7c1e9a4b2d6f80e3a5c7b1d94e2f68ab')
on conflict (device_key) do nothing;

-- ---------------------------------------------------------------------
-- 7. Optional: helpers for reports (used by the dashboard too)
-- ---------------------------------------------------------------------
create or replace view public.motion_daily as
  select
    device_id,
    date_trunc('day', started_at at time zone 'Asia/Kolkata')::date as day,
    count(*)                                    as sessions,
    sum(coalesce(duration_s, 0))                as total_seconds,
    max(coalesce(duration_s, 0))                as longest_seconds
  from public.motion_sessions
  group by 1, 2;

grant select on public.motion_daily to anon, authenticated;
