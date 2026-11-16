# ESP32 PIR motion logger → Supabase

Everything for the hallway motion sensor: the wiring, the ESP32 sketch that
writes each "light on" interval to Supabase, and a dashboard with live status,
charts and daily reports.

```
motion-logger/
├─ supabase/schema.sql              # paste once in the Supabase SQL editor
├─ firmware/motion_logger/
│  ├─ motion_logger.ino             # the sketch
│  ├─ secrets.h                     # Wi-Fi + keys (private, git-ignored)
│  └─ secrets.h.example
├─ dashboard/                       # index.html · app.js · config.js
├─ serve.js                         # `node serve.js` → http://127.0.0.1:4321
└─ README.md
```

---

## 1. Wiring

Your current setup is correct and works standalone — the LED lights from the
PIR output, the ESP32 only listens.

| PIR module (HC-SR501 / HC-SR505) | ESP32 WROOM-32 | Note |
| --- | --- | --- |
| VCC / + | **VIN** (5 V) | 5 V is fine while the board is on USB. Never feed 5 V into a GPIO. |
| GND / − | **GND** | Common ground for module and LED. |
| OUT | **GPIO 14** | 3.3 V logic, no level shifter needed. |
| LED + | **OUT** (via 220–330 Ω) | Hardware-driven: light on = motion. |
| LED − | **GND** | |

Notes

- GPIO14 is a strapping pin, so it briefly toggles at boot. Harmless as an
  input, but do not add an external pull-up/pull-down to it.
- `VIN` only carries 5 V when the board is powered over USB. If you ever power
  it from a battery/LiPo on `3V3`, feed the PIR from a 5 V rail instead — the
  HC-SR501 needs ≥ 4.5 V.
- The PIR needs **~60 s warm-up** after power-up before it reports reliably.
- Your 30 s "on" time comes from the PIR's own delay pot (`Sx`). `Rx` sets
  sensitivity (yours is near max ≈ 5–7 m). Turn `Sx` down to log shorter
  intervals — the ESP32 does not control that timing.
- Want the ESP32 to switch the LED itself? Move the LED to a free pin (e.g.
  GPIO27 through the resistor) and set `STATUS_LED_PIN = 27` in the sketch. As
  wired today, leave it at `-1`.

Your board is already detected as **COM7** (CP210x USB-UART).

---

## 2. Supabase: the tables (already created)

Project: **motion-logger** — `https://aodrehuwkyhujkjvwjwr.supabase.co`
(ref `aodrehuwkyhujkjvwjwr`), in **your own Supabase account** (org `X`). It is
already created and migrated, and the dashboard and firmware already carry its
URL and publishable key.

What [`supabase/schema.sql`](supabase/schema.sql) created (re-running it is safe):
   - `devices` — one row per board, with a secret device key (never readable
     from the browser);
   - `motion_sessions` — one row per light-on interval (`started_at`,
     `ended_at`, derived `duration_s`);
   - `motion_sessions_ingest` — a `before insert` trigger: it turns the device
     key in the insert body into `device_id` and clears it, so the board writes
     straight into the table. **No RPC has to be created** for logging to work;
- `device_status` / `motion_daily` — read-only views for the dashboard;
- RLS + realtime publication;
- your board: `ESP32 WROOM - PIR hallway`, key
  `dev_7c1e9a4b2d6f80e3a5c7b1d94e2f68ab` (must match `DEVICE_KEY` in
  `secrets.h`).

### Credentials

- **Project URL** → `https://aodrehuwkyhujkjvwjwr.supabase.co`
- **Publishable key** → `sb_publishable_XjL6ejr5Ksw_TlFVWv6o7A_WpO7tvC3`

Both are public client credentials — security comes from RLS. Both already sit
in `dashboard/config.js` and `firmware/motion_logger/secrets.h`. Never put the
`service_role` / secret key in the sketch or the dashboard.

---

## 3. Flash the ESP32

1. Arduino IDE → **Boards Manager** → install **esp32 by Espressif**.
2. Open `firmware/motion_logger/motion_logger.ino`.
3. Edit the `secrets.h` tab:

   ```c
   #define WIFI_SSID       "your-2.4GHz-network"
   #define WIFI_PASSWORD   "…"
   #define SUPABASE_URL      "https://aodrehuwkyhujkjvwjwr.supabase.co"
   #define SUPABASE_ANON_KEY "sb_publishable_XjL6ejr5Ksw_TlFVWv6o7A_WpO7tvC3"
   #define DEVICE_KEY      "dev_7c1e9a4b2d6f80e3a5c7b1d94e2f68ab"
   ```

   The ESP32 is **2.4 GHz only** — a 5 GHz-only SSID will not connect.
4. Board: **ESP32 Dev Module**, Port: **COM7**, Upload speed 921600
   (drop to 115200 if uploads fail; hold **BOOT** while "Connecting…" if it
   still refuses).
5. Open **Serial Monitor at 115200**. You should see:

   ```
   === motion logger booting ===
   [wifi] connecting to … ok 192.168.1.42
   [ntp] syncing. ok
   [boot] done, watching GPIO14
   [motion] START
   ...
   [motion] STOP after 30 s
   [queue] session 30 s from 2026-11-14T15:32:07Z (pending 1)
   [sync] session 30 s ok
   [queue] heartbeat (pending 1)
   [sync] heartbeat ok
   ```

How the sketch behaves:

- **start** on the rising edge, **stop** on the falling edge (after 2 s of
  continuous LOW, so the PIR's own 30 s hold is not split).
- **one request per interval**: the board measures the length itself and the
  interval is sent once it ends, as a single row
  (`POST /rest/v1/motion_sessions`) with `started_at`, `ended_at` and
  `duration_s`. Nothing is stitched together on the server, no TLS socket is
  held open between events, and one motion = one write.
- **live marker on start**: the moment motion begins the board sends one tiny
  `PATCH /rest/v1/devices?last_seen_at=not.is.null` with
  `{"last_seen_at":..,"active_since":..}`. The dashboard reads
  `device_status.active_since` and runs the live stopwatch from it, so there is
  no open row and no RPC involved.
- **stop costs nothing**: the trigger that stores the finished interval clears
  `active_since` in the same statement, so the board never sends a stop request.
- **heartbeat** every 10 s (same PATCH, `active_since: null` while nothing is
  running) so the dashboard can tell idle from offline: 30 s of silence means
  the board lost power, and the pill flips to OFF on the next 1 s tick. Pulling
  the plug also leaves no marker behind for long. The filter is required:
  PostgREST refuses an UPDATE without a WHERE clause (21000) and Postgres only
  lets a filtered UPDATE see rows that pass a SELECT policy, both of which
  `schema.sql` accounts for.
- Failed requests are queued in RAM (16 items) and retried every 15 s; a new
  item is sent immediately. A full queue drops heartbeats before it ever drops
  a measured interval.
- Times are UTC from NTP; if the clock is not synced yet the interval waits in
  the queue until it is, instead of being written with a wrong time.

---

## 4. Run the dashboard

```bash
cd motion-logger
node serve.js          # → http://127.0.0.1:4321
```

Open the URL — it already points at your project through `dashboard/config.js`.
(If you ever point it at a different project, clear the setup card by pasting
the new URL and publishable key there instead.)

What you get:

- **Live pill** — `Detection Device ON · 12s` updates every second via Supabase
  Realtime; falls back to 60 s polling if the WebSocket is blocked.
- **KPIs** — light-on time today, number of intervals, longest interval,
  last activity.
- **Last 24 hours / Last 14 days** — light-on time per hour/day (hover a bar).
- **Daily report** — 7 days: intervals, total on-time, longest, share of day.
- **Recent intervals** — latest 25 sessions with running/stale/ended state.

---

## 5. Reports straight from SQL

```sql
-- today, local time (IST)
select count(*) as intervals,
       sum(duration_s) as seconds_on,
       max(duration_s) as longest
from motion_sessions
where started_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';

-- busiest hours of the last 7 days
select extract(hour from started_at at time zone 'Asia/Kolkata') as hour,
       count(*) as intervals,
       sum(duration_s) as seconds_on
from motion_sessions
where started_at > now() - interval '7 days'
group by 1 order by 2 desc;

-- ready-made daily rollup
select * from motion_daily order by day desc limit 14;
```

---

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `[http] session .. -> 401/403` | Wrong `SUPABASE_ANON_KEY`, or the insert policy is missing — re-run `schema.sql`. |
| `[http] session .. -> 404` | `motion_sessions` missing — run `schema.sql` in the right project. |
| `Could not find the 'device_key' column` | Old schema: re-run `schema.sql` (it adds the ingest column + trigger). |
| `unknown device key` in the serial log | `DEVICE_KEY` in `secrets.h` ≠ the row in `devices`. |
| Dashboard says `Could not read from Supabase` | Wrong URL/key, or the RLS policy was not created. |
| Dashboard connected but no rows | Sketch never reached `[sync] session .. ok`; check the serial log. |
| Live pill says "device offline" | No heartbeat for 30 s: board unplugged, Wi-Fi down, or PIR on a 5 GHz SSID. |
| Live timer never starts | `[sync] live start ok` missing in the serial log: the `active_since` column or the devices PATCH is missing — re-run `schema.sql`. |
| Live timer keeps running with no motion | Stale marker after a power cut; the next heartbeat (10 s) clears it, or run the SQL below. |
| `[http] heartbeat -> 400` `21000` | Old schema/patch without a filter: re-run `schema.sql` and re-flash the sketch. |
| `permission denied for table devices` on a direct read | Expected: `devices` is column-granted and `device_key` is never readable; use the `device_status` view. |
| Interval stuck as "stale" | Board lost power mid-session; it closes itself on the next `start` (or see the SQL below). |
| Upload: `Failed to connect` | Hold **BOOT**, or lower upload speed to 115200. |
| Garbage in Serial Monitor | Wrong port or wrong baud (115200). |

Manually close a stuck interval, or drop a stale live marker:

```sql
update motion_sessions set ended_at = now() where ended_at is null;
update devices set active_since = null where active_since is not null;
```

The dashboard is read-only by design: `motion_sessions` accepts inserts (guarded
by the device key in a trigger) and has no update or delete policy, so the
publishable key in a browser can never edit or erase stored sessions.
