-- =====================================================================
--  Motion logger schema  (Supabase project: motion-logger,
--  ref YOUR-PROJECT-REF)
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
  active_since timestamptz,               -- detection in progress: set by the board on START,
                                          -- cleared by the session trigger on STOP
  created_at   timestamptz not null default now()
);

alter table public.devices add column if not exists active_since timestamptz;

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
-- 3. Ingest - the device writes ONE row per interval, straight into the
--    standard table:  POST /rest/v1/motion_sessions
--
--    No RPC, so a missing/non-created function can never turn logging into a
--    404. The interval length is measured on the board and sent with the row;
--    the server only stores it. The device key travels in the insert body and
--    is swapped for the device id by a BEFORE INSERT trigger, so the firmware
--    never needs to know (or hardcode) a device UUID.
-- ---------------------------------------------------------------------
alter table public.motion_sessions add column if not exists device_key text;

comment on column public.motion_sessions.device_key is
  'Write-only ingest field. The device sends its key here; the trigger below resolves it to device_id and clears it, so stored rows always have device_key = NULL.';

create or replace function public.motion_sessions_ingest()
returns trigger
language plpgsql
security definer                      -- needs to read devices, which anon cannot
set search_path = public
as $$
declare
  v_device uuid;
begin
  select id into v_device from public.devices where device_key = new.device_key;

  if v_device is null then
    raise exception 'unknown device key' using errcode = '28000';
  end if;

  -- the key decides which device the row belongs to, never the client
  new.device_id  := v_device;
  new.device_key := null;

  if new.started_at is null then new.started_at := now(); end if;
  if new.ended_at   is null then new.ended_at   := new.started_at; end if;

  -- length is derived from the two stamps, so a wrong duration_s in the body
  -- can never skew the reports
  new.duration_s := greatest(1, round(extract(epoch from (new.ended_at - new.started_at))))::int;

  -- one row per interval already proves the board is alive, and a stored row
  -- also means the detection is over: drop the live marker in the same breath,
  -- so the board never has to send a second "stop" request
  update public.devices
     set last_seen_at = now(),
         active_since = null
   where id = v_device;

  return new;
end;
$$;

drop trigger if exists motion_sessions_ingest_trg on public.motion_sessions;
create trigger motion_sessions_ingest_trg
  before insert on public.motion_sessions
  for each row execute function public.motion_sessions_ingest();

-- Insert is open to the publishable key, because the trigger above is the gate:
-- an unknown key raises, and the key decides device_id.
drop policy if exists motion_sessions_insert on public.motion_sessions;
create policy motion_sessions_insert
  on public.motion_sessions
  for insert to anon, authenticated
  with check (true);

-- insert only: stored history is immutable for the publishable key
grant  insert on public.motion_sessions to anon, authenticated;
revoke update, delete on public.motion_sessions from anon, authenticated;

-- The old three-call RPC is gone; drop it so there is exactly one write path.
drop function if exists public.motion_event(text, text, timestamptz);

-- ---------------------------------------------------------------------
-- 3b. Presence and live state - one tiny PATCH does both:
--       PATCH /rest/v1/devices?last_seen_at=not.is.null
--       {"last_seen_at":"...","active_since":"..."}   -- detection started
--       {"last_seen_at":"...","active_since":null}    -- idle / heartbeat
--     The trigger in section 3 clears active_since when the finished interval
--     arrives, so STOP costs no extra request at all.
--     Two rules decide the filter:
--       * PostgREST rejects an UPDATE with no WHERE clause (21000, "UPDATE
--         requires a WHERE clause"), so a bare PATCH updates nothing at all.
--       * Postgres only lets a filtered UPDATE read rows that also pass a
--         SELECT policy, so devices needs a read policy (section 4).
--     "not null" is the one filter that needs no device id, and this project has
--     a single device row, so "set last_seen_at on the device row(s)" is exactly
--     the intent. Switch to a per-device filter (id=eq.<uuid>) only if you ever
--     run several boards. Column grants keep the write to those two columns, so a
--     publishable key can never rewrite a device name or its key.
-- ---------------------------------------------------------------------
revoke insert, update, delete on public.devices from anon, authenticated;
grant  update (last_seen_at, active_since) on public.devices to anon, authenticated;

drop policy if exists devices_heartbeat on public.devices;
create policy devices_heartbeat
  on public.devices
  for update to anon, authenticated
  using (true)
  with check (true);

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

-- Sessions are insert-only for the public key (see section 3), with no update
-- and no delete policy, so a browser can never edit or forge history once it is
-- stored. devices accepts only the last_seen_at heartbeat (section 3b). Its read
-- policy exists because a filtered UPDATE cannot see a single row without one,
-- and the column grants below are what keep device_key unreadable with the
-- publishable key. The dashboard reads the safe columns through the view below.
revoke select on public.devices from anon, authenticated;
grant  select (id, name, created_at, last_seen_at, active_since) on public.devices
  to anon, authenticated;

drop policy if exists devices_read on public.devices;
create policy devices_read
  on public.devices
  for select to anon, authenticated
  using (true);
create or replace view public.device_status as
  select id, name, last_seen_at, active_since from public.devices;

comment on view public.device_status is
  'Narrow, read-only view: exposes device name and last_seen_at, never device_key.';

grant select on public.device_status to anon, authenticated;

-- the dashboard reacts to a START/STOP the moment it happens, so devices has to
-- stream too; replica identity full so an UPDATE carries the whole row
alter table public.devices replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'public'
       and tablename  = 'devices'
  ) then
    alter publication supabase_realtime add table public.devices;
  end if;
end $$;

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
values ('ESP32 WROOM - PIR hallway', 'YOUR_DEVICE_KEY')
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

-- Make PostgREST pick up the new column, trigger and grants immediately, so the
-- board's next retry (15 s) succeeds without waiting for its schema cache.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 8. Admin actions ("Clear log") and stale-session cleanup
-- ---------------------------------------------------------------------
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);

-- No policies: the key can never be read with the publishable key.
alter table public.app_settings enable row level security;

insert into public.app_settings (key, value)
values ('admin_key', 'SenseKinetics')
on conflict (key) do nothing;

-- Delete every logged interval. A bare DELETE is rejected by the database's
-- safe-update guard ("DELETE requires a WHERE clause"), hence "where true".
create or replace function public.clear_motion_log(p_key text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not exists (
    select 1 from public.app_settings
     where key = 'admin_key' and value = p_key
  ) then
    raise exception 'invalid admin key' using errcode = '28000';
  end if;

  delete from public.motion_sessions where true;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.clear_motion_log(text) from public;
grant execute on function public.clear_motion_log(text) to anon, authenticated;

-- Kept for rows written before the single-row ingest (and for anything left
-- open by an old board): the interval ends at the last heartbeat, never at
-- "now". New rows always arrive closed.
create or replace function public.close_stale_sessions(p_grace_minutes int default 3)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with stale as (
    update public.motion_sessions s
       set ended_at = greatest(s.started_at + interval '1 second', d.last_seen_at)
      from public.devices d
     where s.device_id = d.id
       and s.ended_at is null
       and d.last_seen_at < now() - make_interval(mins => p_grace_minutes)
    returning s.id
  )
  select count(*) into v_count from stale;

  return v_count;
end;
$$;

-- Run it every minute when pg_cron is installed.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('close-stale-sessions');
    exception when others then null;
    end;
    perform cron.schedule('close-stale-sessions', '* * * * *', 'select public.close_stale_sessions(3)');
  end if;
end $$;
