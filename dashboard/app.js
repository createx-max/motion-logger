// Supabase client from a CDN — the dashboard is a static page, so there is no build step.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Tiny shortcut: document.getElementById, used everywhere below.
const $ = (id) => document.getElementById(id);

// Time constants, in milliseconds, so the maths below reads clearly.
const HOUR = 3600000; // 60 * 60 * 1000
const DAY = 86400000; // 24 * 60 * 60 * 1000

// An interval that stays "open" for longer than this is treated as broken data.
const STALE_OPEN_MS = 2 * HOUR;

// The board sends a presence heartbeat every 10 s; after this much silence we
// call the device OFF, so pulling the plug shows up within half a minute.
const ONLINE_MS = 30 * 1000; // 30 s: three missed 10 s heartbeats

// How far back we pull rows from the database.
const RANGE_DAYS = 30;

// localStorage keys (browser-only, nothing secret leaves the machine).
const STORE_KEY = 'motion-logger-config';
const THEME_KEY = 'motion-logger-theme';

// Runtime state, kept in module scope so every render function can read it.
let sb = null; // Supabase client, created once the config is known
let rows = []; // all motion_sessions rows, newest first
let device = null; // the single device_status row (heartbeat)
let range = 'today'; // active range: 'today' | '7d' | '30d'
let reloadTimer = null; // debounce handle for realtime updates

/* ---------------------------------------------------------------- helpers */

// Format a duration in milliseconds as "2h 5m" / "5m" / "38s".
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0; // guard against bad input
  const s = Math.round(ms / 1000); // whole seconds
  const h = Math.floor(s / 3600); // whole hours
  const m = Math.floor((s % 3600) / 60); // leftover minutes
  const sec = s % 60; // leftover seconds
  if (h) return `${h}h ${m}m`; // hours are the biggest unit we show
  if (m) return `${m}m`; // then minutes
  return `${sec}s`; // then seconds
}

// "18:42" in the visitor's own clock.
const fmtClock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// "14 Nov" in the visitor's own locale.
const fmtDay = (d) => d.toLocaleDateString([], { day: '2-digit', month: 'short' });

// Midnight of the day containing `t` (local time, not UTC).
function startOfDay(t) {
  const d = new Date(t); // copy so we never mutate the input
  d.setHours(0, 0, 0, 0); // jump to 00:00:00.000
  return d.getTime(); // back to a timestamp
}

// "just now" / "5 min ago" / "3 h ago" / "2 d ago" for a timestamp.
function ago(ms) {
  if (!ms) return 'never'; // no heartbeat at all yet
  const diff = Date.now() - ms; // how long ago it was
  if (diff < 90000) return `${Math.max(1, Math.round(diff / 1000))} s ago`; // seconds, so a 30 s dropout reads right
  if (diff < HOUR) return `${Math.round(diff / 60000)} min ago`; // under an hour
  if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`; // under a day
  return `${Math.round(diff / DAY)} d ago`; // days
}

// The end of an interval in ms.
// Closed rows use their own ended_at; open rows end at the last heartbeat,
// so a powered-off board cannot stretch its last interval to "now".
function rowEnd(row, now) {
  if (row.ended_at) return new Date(row.ended_at).getTime(); // normal, closed interval
  const start = new Date(row.started_at).getTime(); // when this interval began
  const lastSeen = device?.last_seen_at ? new Date(device.last_seen_at).getTime() : 0; // heartbeat time
  const stopAt = lastSeen && now - lastSeen < ONLINE_MS ? now : lastSeen || now; // live only if the device is alive
  return Math.max(start + 1000, Math.min(stopAt, start + STALE_OPEN_MS)); // never negative, never absurdly long
}

// When the current detection began, in ms (0 = nothing running). An open row
// wins because it carries the exact start; otherwise the device row's live
// marker is used - the board PATCHes it on START and the database clears it the
// moment the finished interval is stored, so the timer needs no RPC and no
// open session row.
function activeStartMs() {
  const open = rows.find((r) => !r.ended_at); // interval still open (old firmware)
  if (open) return new Date(open.started_at).getTime(); // exact start from the row
  return device?.active_since ? new Date(device.active_since).getTime() : 0; // live marker
}

// Spread intervals across a list of time buckets ({start, end} pairs).
// Each bucket gets: total ms on, how many intervals started in it, longest one.
function bucketize(raw, now) {
  const buckets = raw.map((b) => ({ ...b, value: 0, count: 0, longest: 0 })); // fresh copy with counters
  for (const row of rows) {
    const s = new Date(row.started_at).getTime(); // interval start
    const e = rowEnd(row, now); // interval end (handles the open row)
    if (!(e > s)) continue; // skip zero/negative intervals
    const dur = e - s; // full length of this interval
    for (const b of buckets) {
      const overlap = Math.min(e, b.end) - Math.max(s, b.start); // how much of it falls in this bucket
      if (overlap <= 0) continue; // no overlap, move on
      b.value += overlap; // accumulate on-time
      if (s >= b.start && s < b.end) { // count the interval in the bucket where it started
        b.count += 1; // bump the counter
        if (dur > b.longest) b.longest = dur; // remember the longest one
      }
    }
  }
  return buckets; // same shape as input, now with data
}

// 24 hourly buckets ending with the current hour.
function hourlyBuckets(now) {
  const anchor = new Date(now); // start from "now"
  anchor.setMinutes(0, 0, 0); // snap to the top of the hour
  const raw = []; // bucket list we are about to build
  for (let i = 23; i >= 0; i--) {
    const start = anchor.getTime() - i * HOUR; // walk 23 hours back to 0
    raw.push({ start, end: start + HOUR }); // one one-hour bucket
  }
  return bucketize(raw, now); // fill with data
}

// `days` daily buckets ending with today.
function dailyBuckets(now, days) {
  const today = startOfDay(now); // midnight today
  const raw = []; // bucket list
  for (let i = days - 1; i >= 0; i--) {
    const start = startOfDay(today - i * DAY); // midnight of each past day
    raw.push({ start, end: start + DAY }); // one full-day bucket
  }
  return bucketize(raw, now); // fill with data
}

// Where the active range begins.
function rangeStart(r, now) {
  if (r === 'today') return startOfDay(now); // since midnight
  return now - (r === '7d' ? 7 : 30) * DAY; // rolling 7 or 30 days
}

/* ---------------------------------------------------------------- charts */

// Draw a bar chart into `host`; labelEvery/labelFn are kept for future tick labels.
function renderChart(host, data, labelEvery, labelFn) {
  const max = Math.max(1, ...data.map((d) => d.value)); // tallest bar sets the scale, never divide by 0
  const nowHour = new Date().setMinutes(0, 0, 0); // current hour, for the "now" highlight
  host.innerHTML = data
    .map((d) => {
      const pct = d.value > 0 ? Math.max(2, (d.value / max) * 100) : 0; // bar height %, minimum sliver when > 0
      const isNow = d.start === nowHour || (d.end - d.start >= DAY && d.end > Date.now()); // current hour/day
      const mins = Math.round(d.value / 60000); // tooltip shows minutes
      return `<div class="col${isNow ? ' now' : ''}" title="${labelFn(d.start)} · ${mins} min on">
        <div class="fill" style="height:${pct}%"></div>
      </div>`; // one bar
    })
    .join(''); // single HTML string
}

// 7 days x 24 hours grid; darker cell = more minutes on.
function renderHeatmap(now) {
  const host = $('heatmap'); // container
  const today = startOfDay(now); // midnight today
  const days = []; // the seven day starts
  for (let i = 6; i >= 0; i--) days.push(startOfDay(today - i * DAY)); // oldest first

  const raw = []; // 168 buckets
  for (const day of days) {
    for (let h = 0; h < 24; h++) raw.push({ start: day + h * HOUR, end: day + (h + 1) * HOUR }); // each hour
  }
  const buckets = bucketize(raw, now); // fill with data

  const cells = []; // HTML fragments
  cells.push('<span></span>'); // empty corner above the hour labels
  for (let h = 0; h < 24; h++) {
    cells.push(`<span class="hour">${h % 3 === 0 ? h : ''}</span>`); // label every third hour
  }
  days.forEach((day, di) => {
    cells.push(`<span class="day">${new Date(day).toLocaleDateString([], { weekday: 'short' })}</span>`); // row label
    for (let h = 0; h < 24; h++) {
      const v = buckets[di * 24 + h].value; // ms on in this hour
      const mins = v / 60000; // to minutes
      const alpha = mins > 0 ? Math.min(0.92, 0.12 + Math.min(1, mins / 20) * 0.8) : 0; // 20+ minutes = full strength
      // color-mix keeps the heatmap in step with the active light/dark accent
      const bg = alpha ? `color-mix(in srgb, var(--accent) ${Math.round(alpha * 100)}%, transparent)` : ''; // transparent when empty
      cells.push(
        `<span class="cell" style="${bg ? `background:${bg}` : ''}" title="${new Date(day).toLocaleDateString()} ${h}:00 · ${Math.round(mins)} min"></span>` // one cell
      );
    }
  });
  host.innerHTML = cells.join(''); // paint the grid
}

/* ---------------------------------------------------------------- render */

// Rebuild every number, chart and table from `rows` + `device`.
function render() {
  const now = Date.now(); // one "now" for the whole pass, so numbers agree
  const from = rangeStart(range, now); // start of the active range
  const inRange = rows.filter((r) => rowEnd(r, now) > from); // an interval that started before the range but ran into it still counts

  const labelFor = { today: 'ON Duration today', '7d': 'ON Duration · 7 days', '30d': 'ON Duration · 30 days' }; // hero wording
  $('heroLabel').textContent = labelFor[range]; // show it

  const total = inRange.reduce((sum, r) => {
    const s = Math.max(new Date(r.started_at).getTime(), from); // clip intervals that started before the range
    return sum + Math.max(0, rowEnd(r, now) - s); // add their on-time inside the range
  }, 0);

  const durations = inRange.map((r) => Math.max(0, rowEnd(r, now) - Math.max(new Date(r.started_at).getTime(), from))); // length inside the range
  const longest = durations.length ? Math.max(...durations) : 0; // the longest one, or 0
  const span = Math.max(1, now - from); // length of the period, never 0

  $('kpiToday').textContent = fmtDur(total); // the big number
  $('kpiTodayMeta').textContent = inRange.length
    ? `${((total / span) * 100).toFixed(1)}% of the period${inRange.length > 1 ? ` · avg ${fmtDur(total / inRange.length)}` : ''}` // share + average
    : 'no motion in this period'; // nothing to say

  $('kpiCount').textContent = String(inRange.length); // intervals in range
  $('kpiLongest').textContent = longest ? fmtDur(longest) : '—'; // longest interval

  const lastSeen = device?.last_seen_at ? new Date(device.last_seen_at).getTime() : 0; // last heartbeat
  const lastEvent = rows.length ? new Date(rows[0].started_at).getTime() : 0; // newest interval
  const lastAny = Math.max(lastSeen, lastEvent); // whichever happened later
  $('kpiLast').textContent = ago(lastAny); // "2 min ago"

  /* live state */
  const online = lastSeen && now - lastSeen < ONLINE_MS; // is the board alive?
  renderStatus(); // ON/OFF pill, tab title and alerts

  /* charts */
  const hourly = hourlyBuckets(now); // last 24 hours
  const daily = dailyBuckets(now, 14); // last 14 days
  renderChart($('chartHourly'), hourly, 3, (t) => fmtClock(new Date(t))); // hourly bars
  renderChart($('chartDaily'), daily, 2, (t) => fmtDay(new Date(t))); // daily bars
  $('axStart').textContent = fmtClock(new Date(hourly[0].start)); // left edge of hourly chart
  $('axDayStart').textContent = fmtDay(new Date(daily[0].start)); // left edge of daily chart

  renderHeatmap(now); // weekly rhythm grid

  /* daily table */
  $('dailyBody').innerHTML = dailyBuckets(now, 7)
    .reverse() // newest first
    .map((d) => {
      const daySpan = Math.max(1, Math.min(d.end, now) - d.start); // today is not a full day yet
      return `<tr>
        <td>${new Date(d.start).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' })}</td>
        <td class="n">${d.count}</td>
        <td class="n">${fmtDur(d.value)}</td>
        <td class="n">${d.longest ? fmtDur(d.longest) : '—'}</td>
        <td class="n">${((d.value / daySpan) * 100).toFixed(1)}%</td>
      </tr>`; // one day per row
    })
    .join('');

  /* intervals table */
  const shown = inRange.slice(0, 50); // newest 50 only, keeps the DOM small
  const maxDur = Math.max(1, ...shown.map((r) => rowEnd(r, now) - new Date(r.started_at).getTime())); // for the inline bars
  $('sessionNote').textContent = inRange.length
    ? `${inRange.length} interval${inRange.length === 1 ? '' : 's'}${inRange.length > shown.length ? ` · showing latest ${shown.length}` : ''}` // count line
    : 'nothing recorded in this period'; // empty state

  $('sessionBody').innerHTML = shown.length
    ? shown
        .map((r) => {
          const s = new Date(r.started_at).getTime(); // interval start
          let state = '<span class="state end">ended</span>'; // default: a normal closed interval
          if (!r.ended_at) {
            state = now - s < STALE_OPEN_MS && online
              ? '<span class="state run">running</span>' // open and the board is alive
              : '<span class="state stale">stale</span>'; // open but the board went quiet
          }
          return `<tr>
            <td>${new Date(s).toLocaleString([], {
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
            })}</td>
            <td class="n">${fmtDur(rowEnd(r, now) - s)}<span class="mini" style="width:${Math.round(
              ((rowEnd(r, now) - s) / maxDur) * 100
            )}%"></span></td>
            <td>${state}</td>
          </tr>`; // one interval per row, with a proportional bar
        })
        .join('')
    : '<tr><td colspan="3" class="empty">No motion recorded yet</td></tr>'; // empty state

  /* footer */
  const busiest = (() => {
    const b = hourlyBuckets(now).slice().sort((a, x) => x.value - a.value)[0]; // busiest hour of the last 24
    return b && b.value > 0 ? fmtClock(new Date(b.start)) : null; // label it
  })();
  const busiestDay = (() => {
    const d = dailyBuckets(now, 14).slice().sort((a, x) => x.value - a.value)[0]; // busiest day of the last 14
    return d && d.value > 0 ? new Date(d.start).toLocaleDateString([], { weekday: 'short' }) : null; // label it
  })();

  $('footMeta').textContent = rows.length
    ? [
        `${rows.length} intervals in ${RANGE_DAYS} days`, // how much data we are reading
        busiest ? `busiest hour ${busiest}` : null, // optional insight
        busiestDay ? `busiest day ${busiestDay}` : null, // optional insight
        inRange.length ? `avg ${fmtDur(total / inRange.length)}` : null, // average interval
      ]
        .filter(Boolean) // drop the nulls
        .join(' · ')
    : 'waiting for the first interval'; // no data yet
  $('updated').textContent = `read ${fmtClock(new Date())}`; // last refresh time
  $('heatNote').textContent = 'When the light is on, hour by hour · last 7 days'; // heatmap caption
}

/* -------------------------------------------------------------- alerts */

const ALERT_KEY = 'motion-logger-alerts'; // remembers the on/off choice
let alertsOn = localStorage.getItem(ALERT_KEY) === '1'; // current choice
let prevState = null; // last known state, so we only notify on changes

// Fire a desktop notification if the visitor allowed it.
function notify(title, body) {
  if (!alertsOn || !('Notification' in window) || Notification.permission !== 'granted') return; // nothing to do
  try {
    new Notification(title, { body }); // first line = title, second = body
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

// Toggle alerts on/off, asking for the browser permission the first time.
async function toggleAlerts() {
  const btn = $('alertBtn'); // the toolbar button
  if (!('Notification' in window)) {
    window.alert('This browser does not support notifications.'); // old browser
    return;
  }

  if (!alertsOn) {
    const permission = Notification.permission === 'granted'
      ? 'granted' // already allowed earlier
      : await Notification.requestPermission(); // ask now
    if (permission !== 'granted') {
      window.alert('Notifications are blocked for this site. Allow them in the browser, then try again.'); // user said no
      return;
    }
    alertsOn = true; // turn on
  } else {
    alertsOn = false; // turn off
  }

  localStorage.setItem(ALERT_KEY, alertsOn ? '1' : '0'); // remember the choice
  btn.classList.toggle('active', alertsOn); // visual state
  btn.textContent = alertsOn ? 'Alerts on' : 'Alerts'; // label
}

/** Device ON/OFF comes from the heartbeat; detection comes from the open interval. */
function renderStatus() {
  const now = Date.now(); // current time
  const lastSeen = device?.last_seen_at ? new Date(device.last_seen_at).getTime() : 0; // last heartbeat
  const online = Boolean(lastSeen) && now - lastSeen < ONLINE_MS; // alive within the last 30 s?
  const activeStart = activeStartMs(); // when the current detection began, 0 if none
  const openAge = activeStart ? now - activeStart : 0; // its age in ms
  const detecting = Boolean(activeStart) && openAge < STALE_OPEN_MS && online; // live only while the board is alive

  /* tab title + alerts */
  const state = !online ? 'off' : detecting ? 'detecting' : 'idle'; // the three states
  document.title = state === 'off'
    ? 'OFF · Scintal Sense' // tab shows OFFLINE
    : state === 'detecting'
      ? `ON ${fmtDur(openAge)} · Scintal Sense` // tab shows a live timer
      : 'ON idle · Scintal Sense'; // tab shows idle

  if (prevState && prevState !== state) {
    if (state === 'detecting') {
      notify('KPMatrix detected', `Detection device ON at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`); // motion started
    } else if (state === 'off') {
      notify('Detection device OFF', 'The board stopped sending heartbeats.'); // board went quiet
    }
  }
  prevState = state; // remember for the next tick

  const dot = $('dot'); // the status dot
  dot.classList.remove('on', 'idle', 'off'); // clear the old colour

  if (!online) {
    dot.classList.add('off'); // grey
    $('liveText').textContent = lastSeen
      ? `Detection Device OFF · last seen ${ago(lastSeen)}` // how long it has been gone
      : 'Detection Device OFF · no heartbeat yet'; // never heard from it
    return;
  }

  if (detecting) {
    dot.classList.add('on'); // pulsing accent
    $('liveText').textContent = `Detection Device ON · detecting ${fmtDur(openAge)}`; // live timer
    return;
  }

  dot.classList.add('idle'); // red, but the device is alive
  $('liveText').textContent = 'Detection Device ON · idle'; // online, nothing detected
}

// Called once a second by the clock tick; only the pill needs refreshing.
function renderLive() {
  renderStatus(); // cheap, does not touch the charts
}

/* ---------------------------------------------------------------- clear */
// Delete every logged interval. The browser cannot delete rows directly, so it
// calls a database function that checks the admin key first.
async function clearLog() {
  if (!sb) return; // nothing loaded yet
  const key = window.prompt('Admin key required to clear the log:'); // ask for the key
  if (!key) return; // cancelled
  if (!window.confirm('Delete every logged interval? This cannot be undone.')) return; // second chance

  const { data, error } = await sb.rpc('clear_motion_log', { p_key: key.trim() }); // run the database function
  if (error) {
    window.alert(`Could not clear: ${error.message}`); // wrong key or network problem
    return;
  }

  await load(); // pull the now-empty table
  window.alert(`Cleared ${data ?? 0} interval${data === 1 ? '' : 's'}.`); // confirm the count
}

/* ---------------------------------------------------------------- csv */
const IST_OFFSET_MS = (5 * 60 + 30) * 60000; // India is UTC+5:30, regardless of the viewer's clock

/** UTC instant -> "YYYY-MM-DD HH:mm:ss" in IST, regardless of the viewer's clock */
function istStamp(ms) {
  const d = new Date(ms + IST_OFFSET_MS); // shift the instant, then read UTC parts
  const p = (n) => String(n).padStart(2, '0'); // zero-pad helper
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// Download the intervals of the active range as a CSV file.
function exportCsv() {
  const now = Date.now(); // one "now" for every row
  const from = rangeStart(range, now); // active range start
  const list = rows.filter((r) => rowEnd(r, now) > from).slice().reverse(); // oldest first, midnight-spanning rows included
  const lines = ['started_at_ist,ended_at_ist,duration_seconds,state']; // header
  for (const r of list) {
    const s = new Date(r.started_at).getTime(); // start
    const dur = Math.round((rowEnd(r, now) - s) / 1000); // duration in seconds
    lines.push(
      [
        istStamp(s), // start in IST
        r.ended_at ? istStamp(new Date(r.ended_at).getTime()) : '', // end in IST, blank while running
        dur, // seconds
        r.ended_at ? 'ended' : 'running', // state
      ].join(',')
    );
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' }); // the file contents
  const a = document.createElement('a'); // temporary link
  a.href = URL.createObjectURL(blob); // point it at the blob
  a.download = `detection-log-${range}-${new Date().toISOString().slice(0, 10)}.csv`; // file name
  a.click(); // start the download
  URL.revokeObjectURL(a.href); // free the memory
}

/* ---------------------------------------------------------------- data */
// Read sessions and the device heartbeat, then repaint.
async function load() {
  const since = new Date(Date.now() - RANGE_DAYS * DAY).toISOString(); // 30 days back
  const [sessions, status] = await Promise.all([
    sb
      .from('motion_sessions') // every interval
      .select('id,started_at,ended_at,duration_s') // only the columns we use
      .gte('started_at', since) // inside the window
      .order('started_at', { ascending: false }) // newest first
      .limit(2000), // safety cap
    sb.from('device_status').select('id,name,last_seen_at,active_since').limit(1), // device row + live marker
  ]);

  if (sessions.error) throw sessions.error; // surface read errors
  rows = sessions.data || []; // keep the rows
  device = status.error ? null : (status.data || [])[0] || null; // keep the heartbeat

  $('errorBanner').hidden = true; // hide any old error
  render(); // repaint
}

// The pill runs on a 30 s deadline, so it cannot wait for the 60 s safety
// reload or trust realtime alone (a dropped WebSocket would make a live board
// look dead). One device row every 10 s is cheap and keeps last_seen_at honest.
async function refreshDevice() {
  if (!sb) return; // nothing loaded yet
  const { data, error } = await sb
    .from('device_status') // the single device row
    .select('id,name,last_seen_at,active_since') // heartbeat + live marker
    .limit(1);
  if (error || !data) return; // keep the last known state; load() reports failures
  const next = data[0] || null; // the row, if the device is registered
  const markerChanged = (next?.active_since || null) !== (device?.active_since || null); // started or stopped?
  device = next; // freshest heartbeat/marker
  if (markerChanged) return scheduleReload(); // a detection began or ended: refresh the tables
  renderStatus(); // just repaint the pill
}

// Realtime fires a burst of events; collapse them into one reload.
function scheduleReload() {
  if (reloadTimer) return; // already queued
  reloadTimer = setTimeout(async () => {
    reloadTimer = null; // reset the handle
    try {
      await load(); // fetch and repaint
    } catch (err) {
      showError(err); // tell the visitor
    }
  }, 400);
}

// Show a red banner with the failure reason.
function showError(err) {
  const banner = $('errorBanner'); // the banner element
  banner.hidden = false; // make it visible
  banner.textContent = `Could not read from Supabase: ${err?.message || err}`; // the message
}

/* ---------------------------------------------------------------- theme */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)'); // the OS preference

// Which theme is selected: 'auto' | 'light' | 'dark'.
function currentTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'auto'; // saved choice, else auto
  } catch {
    return 'auto'; // private mode without storage
  }
}

// Apply a theme and highlight the matching button.
function applyTheme(mode, remember = true) {
  const dark = mode === 'dark' || (mode === 'auto' && darkQuery.matches); // resolve "auto"
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'; // CSS tokens switch on this
  document.querySelectorAll('[data-theme-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeMode === mode); // mark the active button
  });
  if (remember) {
    try {
      localStorage.setItem(THEME_KEY, mode); // persist the choice
    } catch {
      /* ignore */
    }
  }
}

// Keyboard shortcut 't' cycles Auto -> Light -> Dark -> Auto.
function cycleTheme() {
  const order = ['auto', 'light', 'dark']; // the cycle
  applyTheme(order[(order.indexOf(currentTheme()) + 1) % order.length]); // next one
}

// Follow the OS when the visitor is on "Auto".
darkQuery.addEventListener('change', () => {
  if (currentTheme() === 'auto') applyTheme('auto', false); // repaint, do not persist
});

/* ---------------------------------------------------------------- ranges */
// Switch the active range and update the URL hash.
function setRange(next, updateUrl = true) {
  range = next; // remember it
  document.querySelectorAll('[data-range]').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === next); // highlight the button
  });
  if (updateUrl) history.replaceState(null, '', `#${next}`); // shareable link
  if (rows.length) render(); // repaint when data is already here
}

/* ---------------------------------------------------------------- boot */
// Where do the Supabase URL and key come from?
function readConfig() {
  const injected = window.MOTION_CONFIG || {}; // config.js may inject them
  if (
    injected.supabaseUrl &&
    injected.supabaseAnonKey &&
    !injected.supabaseUrl.includes('YOUR') &&
    !injected.supabaseAnonKey.includes('YOUR')
  ) {
    return { url: injected.supabaseUrl, key: injected.supabaseAnonKey }; // real injected values
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); // or the setup form
    if (saved?.url && saved?.key) return saved; // use what the visitor saved
  } catch {
    /* ignore */
  }
  return null; // nothing configured yet
}

// Wire the UI, connect and start the timers.
async function start() {
  document.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => setRange(btn.dataset.range)); // range buttons
  });
  document.querySelectorAll('[data-theme-mode]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeMode)); // theme buttons
  });
  applyTheme(currentTheme(), false); // apply the saved theme before first paint

  const fromHash = location.hash.replace('#', ''); // e.g. "#7d"
  setRange(['today', '7d', '30d'].includes(fromHash) ? fromHash : 'today', false); // restore the range

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return; // do not hijack typing
    const key = event.key.toLowerCase(); // normalise
    if (key === '1') setRange('today'); // 1 = today
    else if (key === '2') setRange('7d'); // 2 = 7 days
    else if (key === '3') setRange('30d'); // 3 = 30 days
    else if (key === 'e') exportCsv(); // e = export
    else if (key === 't') cycleTheme(); // t = theme
  });

  $('exportBtn').addEventListener('click', exportCsv); // toolbar export
  $('clearBtn').addEventListener('click', clearLog); // toolbar clear
  $('alertBtn').addEventListener('click', toggleAlerts); // toolbar alerts
  $('alertBtn').classList.toggle('active', alertsOn); // reflect the saved choice
  $('alertBtn').textContent = alertsOn ? 'Alerts on' : 'Alerts'; // label
  $('wrap').classList.add('ready'); // fade the page in

  $('setupForm').addEventListener('submit', (event) => {
    event.preventDefault(); // stay on the page
    const url = $('inUrl').value.trim().replace(/\/+$/, ''); // trim and drop trailing slashes
    const key = $('inKey').value.trim(); // trim the key
    if (!url || !key) return; // both are required
    localStorage.setItem(STORE_KEY, JSON.stringify({ url, key })); // store in this browser only
    location.reload(); // restart with the new config
  });

  const cfg = readConfig(); // find the credentials
  if (!cfg) {
    $('setupBanner').hidden = false; // ask the visitor to connect
    $('liveText').textContent = 'not configured'; // explain the empty state
    return;
  }

  $('setupBanner').hidden = true; // config found, hide the form
  sb = createClient(cfg.url, cfg.key, { auth: { persistSession: false } }); // read-only client, no login

  try {
    await load(); // first paint
  } catch (err) {
    showError(err); // explain a failure
  }

  sb.channel('motion-logger')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'motion_sessions' }, scheduleReload) // live inserts
    // The board pings every 10 s, so a full reload per beat would refetch the
    // whole window for nothing. Realtime only tells us "the device row moved":
    // copy the two live columns locally and repaint the pill, and fetch again
    // only when a detection actually started or stopped.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, (payload) => {
      const next = payload.new || {}; // the updated device row
      if (!next.id) return; // deletes carry no row we can use
      const markerChanged = (next.active_since || null) !== (device?.active_since || null); // started or stopped?
      device = { ...(device || {}), ...next }; // keep last_seen_at and active_since fresh
      if (markerChanged) scheduleReload(); // refresh the tables too
      else render(); // heartbeat only: repaint, no network
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        $('liveText').textContent = 'live updates offline — polling'; // realtime died, we still poll
      }
    });

  // cheap 1s tick: keeps the running timer alive without rebuilding the DOM
  setInterval(renderLive, 1000);

  // keep the online pill within its 30 s deadline even without realtime
  setInterval(() => {
    refreshDevice().catch(() => {}); // network blips are handled by the next tick
  }, 10000);

  // safety net: refresh from the database every minute even if realtime is quiet
  setInterval(() => {
    load().catch(showError); // reload, report failures
  }, 60000);
}

start(); // go
