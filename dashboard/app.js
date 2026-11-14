import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const $ = (id) => document.getElementById(id);
const HOUR = 3600000;
const DAY = 86400000;
const STALE_OPEN_MS = 2 * HOUR;
const ONLINE_MS = 2 * 60000; // firmware heartbeats every 30 s
const RANGE_DAYS = 30;
const STORE_KEY = 'motion-logger-config';
const THEME_KEY = 'motion-logger-theme';

let sb = null;
let rows = [];
let device = null;
let range = 'today';
let reloadTimer = null;

/* ---------------------------------------------------------------- helpers */
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

const fmtClock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => d.toLocaleDateString([], { day: '2-digit', month: 'short' });

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ago(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < HOUR) return `${Math.round(diff / 60000)} min ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`;
  return `${Math.round(diff / DAY)} d ago`;
}

function rowEnd(row, now) {
  if (row.ended_at) return new Date(row.ended_at).getTime();
  const start = new Date(row.started_at).getTime();
  const lastSeen = device?.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
  // an interval on a silent device ends at its last heartbeat, not "now"
  const stopAt = lastSeen && now - lastSeen < ONLINE_MS ? now : lastSeen || now;
  return Math.max(start + 1000, Math.min(stopAt, start + STALE_OPEN_MS));
}

function bucketize(raw, now) {
  const buckets = raw.map((b) => ({ ...b, value: 0, count: 0, longest: 0 }));
  for (const row of rows) {
    const s = new Date(row.started_at).getTime();
    const e = rowEnd(row, now);
    if (!(e > s)) continue;
    const dur = e - s;
    for (const b of buckets) {
      const overlap = Math.min(e, b.end) - Math.max(s, b.start);
      if (overlap <= 0) continue;
      b.value += overlap;
      if (s >= b.start && s < b.end) {
        b.count += 1;
        if (dur > b.longest) b.longest = dur;
      }
    }
  }
  return buckets;
}

function hourlyBuckets(now) {
  const anchor = new Date(now);
  anchor.setMinutes(0, 0, 0);
  const raw = [];
  for (let i = 23; i >= 0; i--) {
    const start = anchor.getTime() - i * HOUR;
    raw.push({ start, end: start + HOUR });
  }
  return bucketize(raw, now);
}

function dailyBuckets(now, days) {
  const today = startOfDay(now);
  const raw = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = startOfDay(today - i * DAY);
    raw.push({ start, end: start + DAY });
  }
  return bucketize(raw, now);
}

function rangeStart(r, now) {
  if (r === 'today') return startOfDay(now);
  return now - (r === '7d' ? 7 : 30) * DAY;
}

/* ---------------------------------------------------------------- charts */
function renderChart(host, data, labelEvery, labelFn) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const nowHour = new Date().setMinutes(0, 0, 0);
  host.innerHTML = data
    .map((d) => {
      const pct = d.value > 0 ? Math.max(2, (d.value / max) * 100) : 0;
      const isNow = d.start === nowHour || (d.end - d.start >= DAY && d.end > Date.now());
      const mins = Math.round(d.value / 60000);
      return `<div class="col${isNow ? ' now' : ''}" title="${labelFn(d.start)} · ${mins} min on">
        <div class="fill" style="height:${pct}%"></div>
      </div>`;
    })
    .join('');
}

function renderHeatmap(now) {
  const host = $('heatmap');
  const today = startOfDay(now);
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(startOfDay(today - i * DAY));

  const raw = [];
  for (const day of days) {
    for (let h = 0; h < 24; h++) raw.push({ start: day + h * HOUR, end: day + (h + 1) * HOUR });
  }
  const buckets = bucketize(raw, now);

  const cells = [];
  cells.push('<span></span>');
  for (let h = 0; h < 24; h++) {
    cells.push(`<span class="hour">${h % 3 === 0 ? h : ''}</span>`);
  }
  days.forEach((day, di) => {
    cells.push(`<span class="day">${new Date(day).toLocaleDateString([], { weekday: 'short' })}</span>`);
    for (let h = 0; h < 24; h++) {
      const v = buckets[di * 24 + h].value;
      const mins = v / 60000;
      const alpha = mins > 0 ? Math.min(0.92, 0.12 + Math.min(1, mins / 20) * 0.8) : 0;
      // color-mix keeps the heatmap in step with the active light/dark accent
      const bg = alpha ? `color-mix(in srgb, var(--accent) ${Math.round(alpha * 100)}%, transparent)` : '';
      cells.push(
        `<span class="cell" style="${bg ? `background:${bg}` : ''}" title="${new Date(day).toLocaleDateString()} ${h}:00 · ${Math.round(mins)} min"></span>`
      );
    }
  });
  host.innerHTML = cells.join('');
}

/* ---------------------------------------------------------------- render */
function render() {
  const now = Date.now();
  const from = rangeStart(range, now);
  const inRange = rows.filter((r) => new Date(r.started_at).getTime() >= from);

  const labelFor = { today: 'ON Duration today', '7d': 'ON Duration · 7 days', '30d': 'ON Duration · 30 days' };
  $('heroLabel').textContent = labelFor[range];

  const total = inRange.reduce((sum, r) => {
    const s = Math.max(new Date(r.started_at).getTime(), from);
    return sum + Math.max(0, rowEnd(r, now) - s);
  }, 0);

  const durations = inRange.map((r) => rowEnd(r, now) - new Date(r.started_at).getTime());
  const longest = durations.length ? Math.max(...durations) : 0;
  const span = Math.max(1, now - from);

  $('kpiToday').textContent = fmtDur(total);
  $('kpiTodayMeta').textContent = inRange.length
    ? `${((total / span) * 100).toFixed(1)}% of the period${inRange.length > 1 ? ` · avg ${fmtDur(total / inRange.length)}` : ''}`
    : 'no motion in this period';

  $('kpiCount').textContent = String(inRange.length);
  $('kpiLongest').textContent = longest ? fmtDur(longest) : '—';

  const lastSeen = device?.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
  const lastEvent = rows.length ? new Date(rows[0].started_at).getTime() : 0;
  const lastAny = Math.max(lastSeen, lastEvent);
  $('kpiLast').textContent = ago(lastAny);

  /* live state */
  const open = rows.find((r) => !r.ended_at);
  const openAge = open ? now - new Date(open.started_at).getTime() : 0;
  const online = lastSeen && now - lastSeen < ONLINE_MS;
  renderStatus();

  /* charts */
  const hourly = hourlyBuckets(now);
  const daily = dailyBuckets(now, 14);
  renderChart($('chartHourly'), hourly, 3, (t) => fmtClock(new Date(t)));
  renderChart($('chartDaily'), daily, 2, (t) => fmtDay(new Date(t)));
  $('axStart').textContent = fmtClock(new Date(hourly[0].start));
  $('axDayStart').textContent = fmtDay(new Date(daily[0].start));

  renderHeatmap(now);

  /* daily table */
  $('dailyBody').innerHTML = dailyBuckets(now, 7)
    .reverse()
    .map((d) => {
      const daySpan = Math.max(1, Math.min(d.end, now) - d.start);
      return `<tr>
        <td>${new Date(d.start).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' })}</td>
        <td class="n">${d.count}</td>
        <td class="n">${fmtDur(d.value)}</td>
        <td class="n">${d.longest ? fmtDur(d.longest) : '—'}</td>
        <td class="n">${((d.value / daySpan) * 100).toFixed(1)}%</td>
      </tr>`;
    })
    .join('');

  /* intervals table */
  const shown = inRange.slice(0, 50);
  const maxDur = Math.max(1, ...shown.map((r) => rowEnd(r, now) - new Date(r.started_at).getTime()));
  $('sessionNote').textContent = inRange.length
    ? `${inRange.length} interval${inRange.length === 1 ? '' : 's'}${inRange.length > shown.length ? ` · showing latest ${shown.length}` : ''}`
    : 'nothing recorded in this period';

  $('sessionBody').innerHTML = shown.length
    ? shown
        .map((r) => {
          const s = new Date(r.started_at).getTime();
          let state = '<span class="state end">ended</span>';
          if (!r.ended_at) {
            state = now - s < STALE_OPEN_MS && online
              ? '<span class="state run">running</span>'
              : '<span class="state stale">stale</span>';
          }
          return `<tr>
            <td>${new Date(s).toLocaleString([], {
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
            })}</td>
            <td class="n">${fmtDur(rowEnd(r, now) - s)}<span class="mini" style="width:${Math.round(
              ((rowEnd(r, now) - s) / maxDur) * 100
            )}%"></span></td>
            <td>${state}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="3" class="empty">No motion recorded yet</td></tr>';

  /* footer */
  const busiest = (() => {
    const b = hourlyBuckets(now).slice().sort((a, x) => x.value - a.value)[0];
    return b && b.value > 0 ? fmtClock(new Date(b.start)) : null;
  })();
  const busiestDay = (() => {
    const d = dailyBuckets(now, 14).slice().sort((a, x) => x.value - a.value)[0];
    return d && d.value > 0 ? new Date(d.start).toLocaleDateString([], { weekday: 'short' }) : null;
  })();

  $('footMeta').textContent = rows.length
    ? [
        `${rows.length} intervals in ${RANGE_DAYS} days`,
        busiest ? `busiest hour ${busiest}` : null,
        busiestDay ? `busiest day ${busiestDay}` : null,
        inRange.length ? `avg ${fmtDur(total / inRange.length)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'waiting for the first interval';
  $('updated').textContent = `read ${fmtClock(new Date())}`;
  $('heatNote').textContent = 'When the light is on, hour by hour · last 7 days';
}

/* -------------------------------------------------------------- alerts */
const ALERT_KEY = 'motion-logger-alerts';
let alertsOn = localStorage.getItem(ALERT_KEY) === '1';
let prevState = null;

function notify(title, body) {
  if (!alertsOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body });
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

async function toggleAlerts() {
  const btn = $('alertBtn');
  if (!('Notification' in window)) {
    window.alert('This browser does not support notifications.');
    return;
  }

  if (!alertsOn) {
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') {
      window.alert('Notifications are blocked for this site. Allow them in the browser, then try again.');
      return;
    }
    alertsOn = true;
  } else {
    alertsOn = false;
  }

  localStorage.setItem(ALERT_KEY, alertsOn ? '1' : '0');
  btn.classList.toggle('active', alertsOn);
  btn.textContent = alertsOn ? 'Alerts on' : 'Alerts';
}

/** Device ON/OFF comes from the heartbeat; detection comes from the open interval. */
function renderStatus() {
  const now = Date.now();
  const lastSeen = device?.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
  const online = Boolean(lastSeen) && now - lastSeen < ONLINE_MS;
  const open = rows.find((r) => !r.ended_at);
  const openAge = open ? now - new Date(open.started_at).getTime() : 0;
  const detecting = open && openAge < STALE_OPEN_MS && online;

  /* tab title + alerts */
  const state = !online ? 'off' : detecting ? 'detecting' : 'idle';
  document.title = state === 'off'
    ? 'OFF · Scintal Sense'
    : state === 'detecting'
      ? `ON ${fmtDur(openAge)} · Scintal Sense`
      : 'ON idle · Scintal Sense';

  if (prevState && prevState !== state) {
    if (state === 'detecting') {
      notify('Motion detected', `Detection device ON at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    } else if (state === 'off') {
      notify('Detection device OFF', 'The board stopped sending heartbeats.');
    }
  }
  prevState = state;

  const dot = $('dot');
  dot.classList.remove('on', 'idle', 'off');

  if (!online) {
    dot.classList.add('off');
    $('liveText').textContent = lastSeen
      ? `Detection Device OFF · last seen ${ago(lastSeen)}`
      : 'Detection Device OFF · no heartbeat yet';
    return;
  }

  if (detecting) {
    dot.classList.add('on');
    $('liveText').textContent = `Detection Device ON · detecting ${fmtDur(openAge)}`;
    return;
  }

  dot.classList.add('idle');
  $('liveText').textContent = 'Detection Device ON · idle';
}

function renderLive() {
  renderStatus();
}

/* ---------------------------------------------------------------- clear */
async function clearLog() {
  if (!sb) return;
  const key = window.prompt('Admin key required to clear the log:');
  if (!key) return;
  if (!window.confirm('Delete every logged interval? This cannot be undone.')) return;

  const { data, error } = await sb.rpc('clear_motion_log', { p_key: key.trim() });
  if (error) {
    window.alert(`Could not clear: ${error.message}`);
    return;
  }

  await load();
  window.alert(`Cleared ${data ?? 0} interval${data === 1 ? '' : 's'}.`);
}

/* ---------------------------------------------------------------- csv */
const IST_OFFSET_MS = (5 * 60 + 30) * 60000;

/** UTC instant -> "YYYY-MM-DD HH:mm:ss" in IST, regardless of the viewer's clock */
function istStamp(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function exportCsv() {
  const now = Date.now();
  const from = rangeStart(range, now);
  const list = rows.filter((r) => new Date(r.started_at).getTime() >= from).slice().reverse();
  const lines = ['started_at_ist,ended_at_ist,duration_seconds,state'];
  for (const r of list) {
    const s = new Date(r.started_at).getTime();
    const dur = Math.round((rowEnd(r, now) - s) / 1000);
    lines.push(
      [
        istStamp(s),
        r.ended_at ? istStamp(new Date(r.ended_at).getTime()) : '',
        dur,
        r.ended_at ? 'ended' : 'running',
      ].join(',')
    );
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `detection-log-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------------------------------------------------------- data */
async function load() {
  const since = new Date(Date.now() - RANGE_DAYS * DAY).toISOString();
  const [sessions, status] = await Promise.all([
    sb
      .from('motion_sessions')
      .select('id,started_at,ended_at,duration_s')
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(2000),
    sb.from('device_status').select('id,name,last_seen_at').limit(1),
  ]);

  if (sessions.error) throw sessions.error;
  rows = sessions.data || [];
  device = status.error ? null : (status.data || [])[0] || null;

  $('errorBanner').hidden = true;
  render();
}

function scheduleReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    try {
      await load();
    } catch (err) {
      showError(err);
    }
  }, 400);
}

function showError(err) {
  const banner = $('errorBanner');
  banner.hidden = false;
  banner.textContent = `Could not read from Supabase: ${err?.message || err}`;
}

/* ---------------------------------------------------------------- theme */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function currentTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(mode, remember = true) {
  const dark = mode === 'dark' || (mode === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelectorAll('[data-theme-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeMode === mode);
  });
  if (remember) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* ignore */
    }
  }
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  applyTheme(order[(order.indexOf(currentTheme()) + 1) % order.length]);
}

darkQuery.addEventListener('change', () => {
  if (currentTheme() === 'auto') applyTheme('auto', false);
});

/* ---------------------------------------------------------------- ranges */
function setRange(next, updateUrl = true) {
  range = next;
  document.querySelectorAll('[data-range]').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === next);
  });
  if (updateUrl) history.replaceState(null, '', `#${next}`);
  if (rows.length) render();
}

/* ---------------------------------------------------------------- boot */
function readConfig() {
  const injected = window.MOTION_CONFIG || {};
  if (
    injected.supabaseUrl &&
    injected.supabaseAnonKey &&
    !injected.supabaseUrl.includes('YOUR') &&
    !injected.supabaseAnonKey.includes('YOUR')
  ) {
    return { url: injected.supabaseUrl, key: injected.supabaseAnonKey };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved?.url && saved?.key) return saved;
  } catch {
    /* ignore */
  }
  return null;
}

async function start() {
  document.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => setRange(btn.dataset.range));
  });
  document.querySelectorAll('[data-theme-mode]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeMode));
  });
  applyTheme(currentTheme(), false);

  const fromHash = location.hash.replace('#', '');
  setRange(['today', '7d', '30d'].includes(fromHash) ? fromHash : 'today', false);

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === '1') setRange('today');
    else if (key === '2') setRange('7d');
    else if (key === '3') setRange('30d');
    else if (key === 'e') exportCsv();
    else if (key === 't') cycleTheme();
  });

  $('exportBtn').addEventListener('click', exportCsv);
  $('clearBtn').addEventListener('click', clearLog);
  $('alertBtn').addEventListener('click', toggleAlerts);
  $('alertBtn').classList.toggle('active', alertsOn);
  $('alertBtn').textContent = alertsOn ? 'Alerts on' : 'Alerts';
  $('wrap').classList.add('ready');

  $('setupForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const url = $('inUrl').value.trim().replace(/\/+$/, '');
    const key = $('inKey').value.trim();
    if (!url || !key) return;
    localStorage.setItem(STORE_KEY, JSON.stringify({ url, key }));
    location.reload();
  });

  const cfg = readConfig();
  if (!cfg) {
    $('setupBanner').hidden = false;
    $('liveText').textContent = 'not configured';
    return;
  }

  $('setupBanner').hidden = true;
  sb = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });

  try {
    await load();
  } catch (err) {
    showError(err);
  }

  sb.channel('motion-logger')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'motion_sessions' }, scheduleReload)
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        $('liveText').textContent = 'live updates offline — polling';
      }
    });

  // cheap 1s tick: keeps the running timer alive without rebuilding the DOM
  setInterval(renderLive, 1000);

  setInterval(() => {
    load().catch(showError);
  }, 60000);
}

start();
