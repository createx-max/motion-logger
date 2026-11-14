import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* ------------------------------------------------------------------ config */
const $ = (id) => document.getElementById(id);
const HOUR = 3600000;
const DAY = 86400000;
const STALE_OPEN_MS = 2 * HOUR;      // an open interval older than this is not "live"
const ONLINE_MS = 15 * 60000;        // device heartbeat is every 5 min
const RANGE_DAYS = 30;               // history pulled for the reports
const STORE_KEY = 'motion-logger-config';

let sb = null;
let rows = [];
let device = null;

/* ------------------------------------------------------------------ helpers */
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
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

/** End of a session: real end, or "now" while it runs. Stale opens are capped. */
function rowEnd(row, now) {
  if (row.ended_at) return new Date(row.ended_at).getTime();
  return Math.min(now, new Date(row.started_at).getTime() + STALE_OPEN_MS);
}

/** Sum overlapping intervals into fixed buckets, counting starts per bucket. */
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

/* ------------------------------------------------------------------ render */
function renderChart(host, data, labelEvery, labelFn) {
  const max = Math.max(1, ...data.map((d) => d.value));
  host.innerHTML = data
    .map((d, i) => {
      const pct = d.value > 0 ? Math.max(3, (d.value / max) * 100) : 0;
      const title = `${labelFn(d.start)} · ${d.value ? fmtDur(d.value) : 'no motion'}`;
      const label =
        i % labelEvery === 0
          ? `<span class="barlabel">${labelFn(d.start)}</span>`
          : '<span class="barlabel">&nbsp;</span>';
      return `<div class="slot" title="${title}">
        <div class="barwrap"><div class="bar${d.value ? '' : ' empty'}" style="height:${pct}%"></div></div>
        ${label}
      </div>`;
    })
    .join('');
}

function render() {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const todayRows = rows.filter((r) => new Date(r.started_at).getTime() >= todayStart);

  const todayMs = todayRows.reduce(
    (sum, r) => sum + Math.max(0, rowEnd(r, now) - Math.max(new Date(r.started_at).getTime(), todayStart)),
    0
  );

  const durations = todayRows.map((r) => rowEnd(r, now) - new Date(r.started_at).getTime());
  const longest = durations.length ? Math.max(...durations) : 0;
  const elapsedToday = Math.max(1, now - todayStart);

  $('kpiToday').textContent = fmtDur(todayMs);
  $('kpiTodayMeta').textContent = todayRows.length
    ? `${((todayMs / elapsedToday) * 100).toFixed(1)}% of the day so far`
    : 'no motion yet today';

  $('kpiCount').textContent = String(todayRows.length);
  $('kpiCountMeta').textContent = todayRows.length
    ? `avg ${fmtDur(todayMs / todayRows.length)} each`
    : '—';

  $('kpiLongest').textContent = longest ? fmtDur(longest) : '—';
  $('kpiLongestMeta').textContent = longest ? 'single interval' : '—';

  const lastSeen = device?.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
  const lastEvent = rows.length ? new Date(rows[0].started_at).getTime() : 0;
  const lastAny = Math.max(lastSeen, lastEvent);

  $('kpiLast').textContent = ago(lastAny);
  $('kpiLastMeta').textContent = lastAny ? new Date(lastAny).toLocaleString() : 'waiting for first event';

  /* live state */
  const open = rows.find((r) => !r.ended_at);
  const openAge = open ? now - new Date(open.started_at).getTime() : 0;
  const online = lastSeen && now - lastSeen < ONLINE_MS;
  const active = open && openAge < STALE_OPEN_MS;

  const pill = $('livePill');
  const text = $('liveText');
  pill.classList.remove('live', 'offline');

  if (active) {
    pill.classList.add('live');
    text.textContent = `MOTION · light on for ${fmtDur(openAge)}`;
  } else if (open) {
    pill.classList.add('offline');
    text.textContent = 'open interval — device went quiet';
  } else if (!online) {
    pill.classList.add('offline');
    text.textContent = lastSeen ? `device offline · ${ago(lastSeen)}` : 'no device heartbeat yet';
  } else {
    text.textContent = 'idle · no motion';
  }

  $('updated').textContent = `updated ${fmtClock(new Date())}`;

  renderChart($('chartHourly'), hourlyBuckets(now), 3, (t) => fmtClock(new Date(t)));
  renderChart($('chartDaily'), dailyBuckets(now, 14), 2, (t) => fmtDay(new Date(t)));

  /* daily report */
  const days = dailyBuckets(now, 7).reverse();
  $('dailyBody').innerHTML = days
    .map((d) => {
      const span = Math.max(1, Math.min(d.end, now) - d.start);
      return `<tr>
        <td>${new Date(d.start).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' })}</td>
        <td class="num">${d.count}</td>
        <td class="num">${fmtDur(d.value)}</td>
        <td class="num">${d.longest ? fmtDur(d.longest) : '—'}</td>
        <td class="num">${((d.value / span) * 100).toFixed(1)}%</td>
      </tr>`;
    })
    .join('');

  /* recent intervals */
  const latest = rows.slice(0, 25);
  $('sessionBody').innerHTML = latest.length
    ? latest
        .map((r) => {
          const s = new Date(r.started_at).getTime();
          let tag = '<span class="tag done">ended</span>';
          if (!r.ended_at) {
            tag = now - s < STALE_OPEN_MS
              ? '<span class="tag live">running</span>'
              : '<span class="tag stale">stale</span>';
          }
          return `<tr>
            <td>${new Date(s).toLocaleString([], {
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
            })}</td>
            <td class="num">${fmtDur(rowEnd(r, now) - s)}</td>
            <td>${tag}</td>
          </tr>`;
        })
        .join('')
    : '<tr class="empty-row"><td colspan="3">No motion recorded yet — wave at the sensor.</td></tr>';
}

/* ------------------------------------------------------------------ data */
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

let reloadTimer = null;
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

/* ------------------------------------------------------------------ boot */
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
    /* corrupt storage, ignore */
  }
  return null;
}

async function start() {
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

  /* realtime: any insert/update on motion_sessions refreshes the view */
  sb.channel('motion-logger')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'motion_sessions' }, scheduleReload)
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        $('liveText').textContent = 'live updates offline — polling';
      }
    });

  /* keeps the running interval ticking without re-querying */
  setInterval(() => {
    if (rows.length || device) render();
  }, 1000);

  /* safety net if realtime is blocked on this network */
  setInterval(() => {
    load().catch(showError);
  }, 60000);
}

$('setupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const url = $('inUrl').value.trim().replace(/\/+$/, '');
  const key = $('inKey').value.trim();
  if (!url || !key) return;
  localStorage.setItem(STORE_KEY, JSON.stringify({ url, key }));
  location.reload();
});

start();
