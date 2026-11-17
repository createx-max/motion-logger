/*
 * Scintal Sense Data Logger V3 — ESP32 firmware
 * ----------------------------------------------------------
 * Wiring
 *   SENSOR  VCC  -> ESP32 VIN  (5 V, only valid while powered over USB)
 *   SENSOR  GND  -> ESP32 GND
 *   SENSOR  OUT  -> ESP32 GPIO14 (D14)
 *   LED  +    -> SENSOR OUT    (through a 220-330 ohm resistor)
 *   LED  -    -> SENSOR GND
 *
 * What it does
 *   Reads the SENSOR output, measures each "light on" period on the board and
 *   sends it as ONE row to the standard motion_sessions table:
 *
 *     POST /rest/v1/motion_sessions
 *     {"device_key":..,"started_at":..,"ended_at":..,"duration_s":..}
 *
 *   There is no RPC involved, so nothing has to be "programmed" first and a
 *   missing function cannot turn logging into a 404. A trigger in schema.sql
 *   swaps the device key for the device id, so the board never needs a UUID.
 *
 *     live     -> PATCH /rest/v1/devices?last_seen_at=not.is.null with
 *                  {"last_seen_at":..,"active_since":..} the moment motion
 *                  starts, so the dashboard can run a live stopwatch. No RPC,
 *                  no open row: the marker lives in the device row.
 *     heartbeat -> the same PATCH every 10 s, with active_since:null while
 *                  nothing is running, which is how the dashboard tells ON from
 *                  OFF within 30 s and how a stuck marker gets cleared.
 *     stop     -> no request at all: the trigger that stores the finished
 *                  interval clears active_since itself.
 *
 *   The signal is followed by a hardware interrupt, not by polling. That means
 *   a short pulse that starts and ends between two loop passes is still logged,
 *   and a blocking network call (Wi-Fi connect, NTP) can no longer swallow an
 *   event: the edges are captured even while the loop is waiting.
 *
 *   Nothing in the loop blocks: Wi-Fi association and NTP run in the background,
 *   so a slow router or a missing hotspot can never stall edge capture.
 *
 *   No CPU sleep: the loop stays awake, so the interrupt never misses an edge.
 *   The power saving comes from the ESP32's own modem sleep - the radio dozes
 *   between DTIM beacons while Wi-Fi stays associated, no reconnect penalty.
 *
 *   Events that cannot be delivered (no Wi-Fi, timeout, server error) wait in
 *   a small RAM queue and are retried, so a short outage does not lose data.
 *
 * Board: "ESP32 Dev Module"  |  Port: COM7  |  Serial monitor: 115200 baud
 * Needs: Arduino IDE + "esp32 by Espressif" board package (Boards Manager).
 */

#include <WiFi.h>             // Wi-Fi station mode: connect to the home network
#include <WiFiClientSecure.h> // TLS socket used by HTTPS requests
#include <HTTPClient.h>       // simple POST helper on top of the TLS socket
#include <time.h>             // time(), gmtime_r(), strftime() for UTC stamps

#include "secrets.h"          // Wi-Fi name/password, Supabase URL + key, device key
// ---------------------------------------------------------------- settings

// GPIO wired to the  OUT pin (D14 on the ESP32 dev board).
static const int      SENSOR_PIN        = 14;

// Optional extra LED on a free GPIO; -1 means "not fitted".
static const int      STATUS_LED_PIN = -1;

// The signal must stay LOW this long before we call the light "off".
static const uint32_t HOLD_MS      = 2000UL;

// Safety valve: never let one session run longer than 30 minutes.
static const uint32_t MAX_OPEN_MS  = 30UL * 60UL * 1000UL;

// Presence cadence. A heartbeat is one tiny PATCH of a single column, and it is
// only sent when no session went up inside the same window, so motion itself
// keeps the device "seen". The dashboard treats 30 s of silence as OFF, so the
// beat has to be well inside that: 10 s leaves room for one missed request.
static const uint32_t HEARTBEAT_MS = 10UL * 1000UL;

// How often a stuck queue is retried while offline.
static const uint32_t RETRY_MS     = 15000UL;

// ---------------------------------------------------------------- queue

// How many unsent items we remember (oldest is dropped when full).
static const uint8_t Q_SIZE = 16;

// What a waiting item is: one finished interval, one presence heartbeat, or the
// "detection started" marker that feeds the live stopwatch.
enum : uint8_t { Q_SESSION = 0, Q_HEARTBEAT = 1, Q_LIVE = 2 };

// One waiting item. A session carries its whole story - start, end and length -
// so a single request can log it, even after a long outage.
struct Pending {
  uint8_t  kind;        // Q_SESSION, Q_HEARTBEAT or Q_LIVE
  uint32_t durationS;   // measured on the board, never on the server
  time_t   startedAt;   // session start (presence: when it was queued); 0 = no clock yet
  time_t   activeSince; // presence only: live marker to assert, 0 = clear it
};

// The ring buffer itself plus its head index and item count.
static Pending  queue[Q_SIZE];
static uint8_t  qHead  = 0; // index of the oldest item
static uint8_t  qCount = 0; // how many items are waiting

// ---------------------------------------------------------------- littlefs (OPTIONAL, commented out)
// The queue below lives in RAM, so a power cut loses whatever was not sent yet.
// Uncommenting this block (plus the two LittleFS lines in platformio.ini) makes
// the queue survive a restart: every change is written to flash, and setup()
// loads it back before the first request goes out. It is commented out on
// purpose - the default build stays small and never touches the flash.
//
// #include <LittleFS.h>
//
// static const char *QUEUE_FILE = "/queue.bin"; // one small binary blob
// static bool fsReady = false;                  // mounted and usable
//
// // Mount the filesystem (format on first use) and restore what was waiting.
// static void fsBegin() {
//   fsReady = LittleFS.begin(true);             // true = format when unformatted
//   if (!fsReady) { Serial.println("[fs] mount failed"); return; }
//   File f = LittleFS.open(QUEUE_FILE, "r");    // may not exist yet
//   if (!f) { Serial.println("[fs] nothing to restore"); return; }
//   uint8_t count = 0;
//   if (f.read(&count, 1) == 1 && count <= Q_SIZE &&
//       f.read((uint8_t *)queue, sizeof(Pending) * count) == sizeof(Pending) * count) {
//     qHead  = 0;                               // restored compacted
//     qCount = count;
//     Serial.printf("[fs] restored %u item(s)\n", qCount);
//   }
//   f.close();
// }
//
// // Rewrite the queue in flash, oldest first. 16 tiny structs, so a save costs
// // a few milliseconds and happens only when the queue actually changed.
// static void fsSave() {
//   if (!fsReady) return;
//   File f = LittleFS.open(QUEUE_FILE, "w");
//   if (!f) return;
//   f.write(&qCount, 1);                        // how many follow
//   for (uint8_t i = 0; i < qCount; i++) {      // in delivery order
//     const uint8_t at = (uint8_t)((qHead + i) % Q_SIZE);
//     f.write((const uint8_t *)&queue[at], sizeof(Pending));
//   }
//   f.close();
// }

// ---------------------------------------------------------------- state

// True while the SENSOR output is being logged as one open session.
static bool     sessionActive  = false;

// millis() at which the current session started.
static uint32_t sessionStartMs = 0;

// millis() of the last moment the signal was known HIGH (the true "light went
// off" moment once the signal has dropped).
static uint32_t lastHighMs     = 0;

// UTC timestamp of the session start; 0 when the clock was not synced yet.
static time_t   sessionStartTs = 0;

// millis() of the last heartbeat we queued.
static uint32_t lastHeartbeatMs = 0;
// Last moment the server actually answered. If the Wi-Fi stack or a TLS call
// wedges, the board goes silent while the dashboard quite correctly calls it
// OFF; a restart is then the only way back, and it costs at most one interval.
static uint32_t lastUploadOkMs = 0;
static const uint32_t WATCHDOG_MS = 120UL * 1000UL; // 2 min of silence while online

// millis() of the last delivery attempt.
static uint32_t lastRetryMs     = 0;

// Set when something new is queued, so it is sent without waiting for RETRY_MS.
static bool     flushRequested  = true;

// True once the current association attempt has reported success (log once).
static bool     wasOnline       = false;

// ---------------------------------------------------------------- sensor interrupt

// The pin is watched by an interrupt, so the loop only has to read these tiny
// variables. Everything below is written inside the ISR and must stay volatile.
static volatile bool     isrLevel   = false; // level the pin had at the last edge
static volatile uint32_t isrEdgeMs  = 0;     // millis() of the last edge
static volatile uint32_t isrRiseSeq = 0;     // how many rising edges so far
static volatile uint32_t isrFallSeq = 0;     // how many falling edges so far

// Rising/falling edges the loop has already turned into events.
static uint32_t seenRiseSeq = 0;
static uint32_t seenFallSeq = 0;

// Runs on every edge of SENSOR_PIN. Kept as short as possible: capture the
// time, remember the level, bump a counter. No Serial, no allocation, no I/O.
static void IRAM_ATTR onSensorEdge() {
  const uint32_t cap = millis();                    // stamp the edge first
  if (digitalRead(SENSOR_PIN) == HIGH) {            // light / motion started
    isrEdgeMs  = cap;                               // remember when it rose
    isrLevel   = true;                              // current level
    isrRiseSeq = isrRiseSeq + 1;                    // one more rising edge
  } else {                                          // it stopped
    isrEdgeMs  = cap;                               // remember when it fell
    isrLevel   = false;                             // current level
    isrFallSeq = isrFallSeq + 1;                    // one more falling edge
  }
}

// ---------------------------------------------------------------- helpers

// Format a UTC timestamp as the ISO-8601 text Postgres accepts, straight into a
// caller-supplied buffer: no String, no heap allocation.
static void isoUtcBuf(time_t t, char *out, size_t n) {
  struct tm tmUtc;                              // broken-down UTC time
  gmtime_r(&t, &tmUtc);                         // fill it from the timestamp
  strftime(out, n, "%Y-%m-%dT%H:%M:%SZ", &tmUtc); // format it in place
}

// Current UTC time, or 0 while the clock is still unset (before 2023).
static time_t nowUnix() {
  time_t t = time(nullptr);                     // read the system clock
  return (t > 1700000000) ? t : 0;              // anything older means "not synced yet"
}

// Drive the optional status LED, if one is wired.
static void setStatusLed(bool on) {
  if (STATUS_LED_PIN >= 0) digitalWrite(STATUS_LED_PIN, on ? HIGH : LOW); // ignore when not fitted
}

// Remove the oldest queued presence item, if there is one. Presence and the live
// marker are disposable, a measured interval is not: this keeps the log intact
// when the queue fills up.
static bool dropOldestPresence() {
  for (uint8_t i = 0; i < qCount; i++) {       // walk from the oldest item
    const uint8_t at = (uint8_t)((qHead + i) % Q_SIZE);
    if (queue[at].kind == Q_SESSION) continue;  // only presence items are expendable
    for (uint8_t j = i; j + 1 < qCount; j++) {  // shift the rest one slot left
      const uint8_t from = (uint8_t)((qHead + j + 1) % Q_SIZE);
      const uint8_t to   = (uint8_t)((qHead + j) % Q_SIZE);
      queue[to] = queue[from];
    }
    qCount--;                                   // one gone
    return true;
  }
  return false;                                 // nothing to give up
}

// Put one item at the back of the queue.
static void enqueue(const Pending &item) {
  if (qCount >= Q_SIZE) {                       // queue full?
    if (item.kind == Q_SESSION) dropOldestPresence(); // free a presence slot first
    if (qCount >= Q_SIZE) {                     // still full: drop the oldest item
      qHead = (uint8_t)((qHead + 1) % Q_SIZE);
      qCount--;
    }
  }
  queue[(uint8_t)((qHead + qCount) % Q_SIZE)] = item; // store a copy
  qCount++;                                     // one more waiting
  flushRequested = true;                        // try to send it on this loop
  if (item.kind == Q_SESSION) {                 // one finished interval
    char when[24];                              // formatted start, or a note
    if (item.startedAt) isoUtcBuf(item.startedAt, when, sizeof(when));
    else                snprintf(when, sizeof(when), "clock unsynced");
    Serial.printf("[queue] session %lu s from %s (pending %u)\n",
                  (unsigned long)item.durationS, when, qCount);
  } else if (item.kind == Q_LIVE) {             // detection just started
    Serial.printf("[queue] live start (pending %u)\n", qCount);
  } else {                                      // presence heartbeat
    Serial.printf("[queue] heartbeat (pending %u)\n", qCount);
  }

  // fsSave(); // a new item has to survive a power cut
}

// Queue one measured interval. startedAt = 0 means the clock was not synced
// when the light came on; postSession() then places it relative to "now".
static void enqueueSession(time_t startedAt, uint32_t durationS) {
  Pending p;                                   // build it on the stack
  p.kind      = Q_SESSION;
  p.durationS = durationS;
  p.startedAt = startedAt;
  enqueue(p);
}

// Queue one presence PATCH. activeSince = 0 means "nothing is running", which
// travels as active_since:null; a real timestamp marks an ongoing detection.
static void enqueuePresence(time_t ts, time_t activeSince) {
  Pending p;
  p.kind        = activeSince ? Q_LIVE : Q_HEARTBEAT;
  p.durationS   = 0;
  p.startedAt   = ts;
  p.activeSince = activeSince;
  enqueue(p);
}

// Open a TLS request with the Supabase headers already on it. The caller owns
// both objects on its own stack, so nothing outlives the call. Returns false
// only when nothing was opened, i.e. when there is no socket to close.
static bool beginRequest(WiFiClientSecure &client, HTTPClient &http,
                         const char *url, const char *auth) {
  client.setInsecure();                         // no CA bundle on the device; traffic is still encrypted
  http.setConnectTimeout(6000);                 // give up connecting after 6 s
  http.setTimeout(8000);                        // and after 8 s of no answer
  if (!http.begin(client, url)) {               // open the connection
    Serial.println("[http] begin() failed");    // bad URL or out of memory
    return false;                               // nothing is open yet
  }
  http.addHeader("apikey", SUPABASE_ANON_KEY);                      // Supabase key header
  http.addHeader("Authorization", auth);                            // and the bearer header
  http.addHeader("Content-Type", "application/json");              // we send JSON
  http.addHeader("Prefer", "return=minimal");                       // no reply body needed
  return true;
}

// POST one finished interval to the standard motion_sessions table. ONE request
// per interval: start, end and length travel together, so the server only stores
// the row - nothing to stitch, no follow-up call, no RPC to exist.
static bool postSession(time_t startedAt, uint32_t durationS) {
  if (WiFi.status() != WL_CONNECTED) return false; // no network, nothing to try

  // Timestamps first: a row without a real clock is useless, so it stays queued
  // until NTP lands (normally a second after boot).
  const time_t nowTs = nowUnix();
  time_t end   = startedAt ? startedAt + (time_t)durationS : nowTs;
  time_t start = startedAt ? startedAt : (end ? end - (time_t)durationS : 0);
  if (!start || !end) return false;             // clock still unset: retry later

  // Everything that can fail is built BEFORE a socket is opened, so no early
  // return can leave a TLS connection dangling.
  char url[96];                                 // stack buffer: no String churn
  snprintf(url, sizeof(url), "%s/rest/v1/motion_sessions", SUPABASE_URL);

  char auth[96];                                // "Bearer <key>" once, on the stack
  snprintf(auth, sizeof(auth), "Bearer %s", SUPABASE_ANON_KEY);

  char sStart[24], sEnd[24];                    // "2026-11-14T18:42:07Z"
  isoUtcBuf(start, sStart, sizeof(sStart));
  isoUtcBuf(end,   sEnd,   sizeof(sEnd));

  // Build the JSON straight into a stack buffer. Repeated String concatenation
  // is what fragments the heap on small boards (the D1 Mini port would die).
  char json[224];
  int len = snprintf(json, sizeof(json),
                     "{\"device_key\":\"%s\",\"started_at\":\"%s\",\"ended_at\":\"%s\",\"duration_s\":%lu}",
                     DEVICE_KEY, sStart, sEnd, (unsigned long)durationS);
  if (len <= 0) return false;                   // formatting failed: keep the row
  if (len >= (int)sizeof(json)) len = (int)sizeof(json) - 1; // never over-read

  WiFiClientSecure client;                      // TLS socket for this request
  HTTPClient http;
  if (!beginRequest(client, http, url, auth)) return false;

  int code = http.POST((uint8_t *)json, (size_t)len); // send the buffer as-is
  bool ok  = (code >= 200 && code < 300);       // 2xx means stored

  if (!ok) {                                    // explain the failure on serial
    String reply = http.getString();            // server's message
    if (reply.length() > 160) reply = reply.substring(0, 160); // keep it short
    Serial.printf("[http] session %lus -> %d %s\n",
                  (unsigned long)durationS, code, reply.c_str());
    if (code == 401 || code == 403) {           // key or insert policy
      Serial.println("[http] check SUPABASE_ANON_KEY and the motion_sessions insert policy");
    } else if (code == 404) {                   // table not created yet
      Serial.println("[http] run supabase/schema.sql in the Supabase SQL editor");
    } else if (reply.indexOf("unknown device key") >= 0) {
      Serial.println("[http] check DEVICE_KEY"); // wrong device key in secrets.h
    }
  }
  http.end();                                   // close the connection
  return ok;                                    // tell the caller
}

// Presence and live state in ONE PATCH of the device row:
//   idle  -> {"last_seen_at":"...","active_since":null}   nothing running
//   start -> {"last_seen_at":"...","active_since":"..."}  detection began
// A start costs one PATCH, a stop costs none at all (the ingest trigger clears
// active_since when the finished interval lands), so one motion = one row + one
// tiny PATCH. A quiet night costs a handful of requests per hour.
// The filter is mandatory: PostgREST rejects an UPDATE without a WHERE clause
// (21000 "UPDATE requires a WHERE clause") and updates nothing. "not null" needs
// no device id - the project has one device row - and Postgres only lets the
// filtered UPDATE see rows that pass a SELECT policy, which schema.sql provides.
static bool postPresence(time_t ts, time_t activeSince) {
  if (WiFi.status() != WL_CONNECTED) return false; // no network, nothing to try

  const time_t when = ts ? ts : nowUnix();      // when it happened
  if (!when) return false;                      // clock still unset

  char url[96];
  snprintf(url, sizeof(url), "%s/rest/v1/devices?last_seen_at=not.is.null",
           SUPABASE_URL);

  char auth[96];
  snprintf(auth, sizeof(auth), "Bearer %s", SUPABASE_ANON_KEY);

  char iso[24], live[24];
  isoUtcBuf(when, iso, sizeof(iso));
  if (activeSince) isoUtcBuf(activeSince, live, sizeof(live));

  // 72 bytes at most, so a 96 byte buffer never clips it
  char json[96];
  int len = activeSince
    ? snprintf(json, sizeof(json),
               "{\"last_seen_at\":\"%s\",\"active_since\":\"%s\"}", iso, live)
    : snprintf(json, sizeof(json),
               "{\"last_seen_at\":\"%s\",\"active_since\":null}", iso);
  if (len <= 0) return false;
  if (len >= (int)sizeof(json)) len = (int)sizeof(json) - 1;

  WiFiClientSecure client;                      // TLS socket for this request
  HTTPClient http;
  if (!beginRequest(client, http, url, auth)) return false;

  int code = http.PATCH((uint8_t *)json, (size_t)len); // update just that column
  bool ok  = (code >= 200 && code < 300);       // 204 is the normal answer

  if (!ok) {
    String reply = http.getString();
    if (reply.length() > 160) reply = reply.substring(0, 160);
    Serial.printf("[http] presence -> %d %s\n", code, reply.c_str());
    if (code == 401 || code == 403) {
      Serial.println("[http] presence needs the devices update grant (schema.sql)");
    } else if (reply.indexOf("active_since") >= 0) {
      Serial.println("[http] active_since missing: re-run supabase/schema.sql");
    }
  }
  http.end();                                   // close the connection
  return ok;                                    // tell the caller
}

// Send everything waiting, stopping at the first failure.
static void flushQueue() {
  while (qCount > 0) {                          // as long as something is pending
    Pending &p = queue[qHead];                  // oldest item
    const bool session = (p.kind == Q_SESSION); // interval or heartbeat?
    const bool sent = session ? postSession(p.startedAt, p.durationS)
                              : postPresence(p.startedAt, p.activeSince);
    if (!sent) return;                          // failed: keep it, retry later
    if (session) {
      Serial.printf("[sync] session %lu s ok\n", (unsigned long)p.durationS);
    } else if (p.kind == Q_LIVE) {
      Serial.println("[sync] live start ok");   // dashboard can start its timer
    } else {
      Serial.println("[sync] heartbeat ok");
    }
    lastHeartbeatMs = millis();                 // every upload already proves presence
    lastUploadOkMs  = millis();                 // the link is alive, so the watchdog stays quiet
    qHead = (uint8_t)((qHead + 1) % Q_SIZE);    // move the head forward
    qCount--;                                   // one fewer waiting

    // fsSave(); // the delivered item is gone from flash too
  }
}

// Join the Wi-Fi network without ever blocking the loop. The ESP32 stack
// connects in the background, so this only kicks off a (re)try. Calling
// begin() again while the stack is still associating ABORTS that attempt
// ("sta is connecting, cannot set config"), which used to turn a normal 5 s join
// into a one-minute one, so an association in flight is left alone.
static uint32_t lastConnectAttemptMs = 0;
static bool     wifiBegun = false;              // has begin() ever been called?
static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;    // already online
  const uint32_t now = millis();
  if (wifiBegun) {                              // only rate-limit real retries
    if (now - lastConnectAttemptMs < 5000UL) return; // do not spam begin()
    if (WiFi.status() == WL_IDLE_STATUS) return;     // still associating: hands off
  }
  lastConnectAttemptMs = now;
  wifiBegun = true;                             // first attempt done
  Serial.printf("[wifi] connecting to %s...\n", WIFI_SSID); // log the network name
  WiFi.mode(WIFI_STA);                          // station mode (client, not access point)
  WiFi.setAutoReconnect(true);                  // let the stack retry on its own
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);         // start connecting (non-blocking)
}

// Report the (non-blocking) association result when it lands.
static void logWifiResult() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] ok %s\n", WiFi.localIP().toString().c_str());
  }
}

// Sync the clock over NTP without blocking. configTime() only arms the client;
// the real sync happens in the background and nowUnix() flips once it lands.
static bool ntpStarted = false;
static void syncTime() {
  if (nowUnix() > 0) return;                    // already have a sane time
  if (!ntpStarted) {
    ntpStarted = true;
    configTime(0, 0, "pool.ntp.org", "time.google.com"); // UTC, two public servers
    Serial.println("[ntp] syncing (background)..."); // progress note
  }
}

// ---------------------------------------------------------------- setup

// Runs once after reset or power-on.
void setup() {
  Serial.begin(115200);                         // open the serial monitor link
  delay(300);                                   // let it settle
  Serial.println();                             // blank line
  Serial.println("=== motion logger booting ==="); // banner

  pinMode(SENSOR_PIN, INPUT);                   // SENSOR OUT is an input to us
  if (STATUS_LED_PIN >= 0) pinMode(STATUS_LED_PIN, OUTPUT); // optional LED is an output
  setStatusLed(false);                          // start with the LED off

  // Watch the pin from now on, so pulses during the Wi-Fi/NTP wait are kept.
  isrLevel = (digitalRead(SENSOR_PIN) == HIGH); // level at boot
  isrEdgeMs = millis();                         // "started" now
  attachInterrupt(digitalPinToInterrupt(SENSOR_PIN), onSensorEdge, CHANGE);

  // fsBegin();                                  // restore the queue from flash (LittleFS, optional)

  connectWifi();                                // start joining (background, non-blocking)
  WiFi.setSleep(true);                          // modem sleep: radio off between beacons
  syncTime();                                   // arm NTP (background, non-blocking)

  lastHeartbeatMs = millis();                   // first heartbeat is due one HEARTBEAT_MS from now
  lastUploadOkMs  = millis();                   // grace period before the watchdog bites
  Serial.println("[SENSOR] warming up - give the sensor ~60 s to settle"); // SENSOR needs time
  Serial.println("[boot] done, watching GPIO14 (D14) by interrupt"); // ready
}

// ---------------------------------------------------------------- loop

// Runs forever, several times per second.
void loop() {
  const uint32_t now = millis();                // current uptime in ms

  // Read the interrupt state once, with interrupts briefly off so a change
  // cannot tear the snapshot.
  noInterrupts();
  const bool     isrLvl  = isrLevel;            // cached level from the ISR
  const uint32_t edgeMs  = isrEdgeMs;           // when the last edge happened
  const uint32_t riseSeq = isrRiseSeq;          // rising edges so far
  const uint32_t fallSeq = isrFallSeq;          // falling edges so far
  interrupts();

  // The pin is the authority. One missed edge (an HTTP call, the snapshots above
  // that run with interrupts off) could leave the cached level stuck on HIGH for
  // ever, and then the session never closed, so nothing was ever written to the
  // table. Reading the pin every pass makes that impossible.
  const bool level = (digitalRead(SENSOR_PIN) == HIGH); // HIGH = motion, LED lit
  if (level != isrLvl) {                        // cached copy drifted: resync it
    noInterrupts();                             // do not race a fresh edge
    isrLevel = level;                           // ISR now agrees with the pin
    interrupts();
    Serial.printf("[sensor] level resynced to %s\n", level ? "HIGH" : "LOW");
  }


  // A rising edge the loop has not handled yet opens (or refreshes) a session.
  if (riseSeq != seenRiseSeq) {
    seenRiseSeq = riseSeq;                      // handled in this pass
    lastHighMs  = edgeMs;                       // last confirmed HIGH
    if (!sessionActive) {                       // a new pulse, not a bounce
      sessionActive  = true;                    // open a session
      sessionStartMs = edgeMs;                  // when the pin actually rose
      sessionStartTs = nowUnix();               // real clock time, 0 if not synced
      setStatusLed(true);                       // mirror the state on the LED
      Serial.println("[motion] START");         // log it
      // One tiny PATCH puts the live marker in the device row; the dashboard
      // reads it straight away. Without a clock there is nothing valid to send.
      if (sessionStartTs) enqueuePresence(sessionStartTs, sessionStartTs);
      else Serial.println("[live] clock not synced yet - no start marker");
    }
  } else if (!sessionActive && level) {
    // Board booted while the signal was already HIGH: no edge will follow.
    sessionActive  = true;
    sessionStartMs = now;
    lastHighMs     = now;
    sessionStartTs = nowUnix();
    setStatusLed(true);
    Serial.println("[motion] START (already high at boot)");
    if (sessionStartTs) enqueuePresence(sessionStartTs, sessionStartTs); // live marker
  }

  // A falling edge stamps the exact moment the signal dropped. This is the
  // "light went off" time, so the row does not end when the loop noticed.
  if (fallSeq != seenFallSeq) {
    seenFallSeq = fallSeq;                      // handled in this pass
    if (edgeMs > lastHighMs) lastHighMs = edgeMs; // exact end of the HIGH period
  }

  if (sessionActive) {
    if (level == HIGH) lastHighMs = now;        // still detecting: keep the end time fresh

    const uint32_t held  = now - lastHighMs;    // time since the last HIGH
    const uint32_t total = now - sessionStartMs; // how long this session has run

    if (held > HOLD_MS || total > MAX_OPEN_MS) { // long enough LOW, or hit the 30 min cap
      // The length is measured here, on the board: one request will carry it.
      uint32_t durS = (lastHighMs - sessionStartMs) / 1000UL; // whole seconds
      if (durS == 0) durS = 1;                  // a logged interval is never empty

      Serial.printf("[motion] STOP after %lu s\n", (unsigned long)durS); // log the length
      enqueueSession(sessionStartTs, durS);     // one row, sent in one request

      sessionActive  = false;                   // ready for the next motion
      sessionStartTs = 0;                       // clear the start stamp
      setStatusLed(false);                      // LED off
    }
  }

  // The clock can land while a session is already running (Wi-Fi associates
  // first, NTP answers a moment later). Fill the start stamp in and publish the
  // live marker then, so the dashboard still gets its stopwatch.
  if (sessionActive && !sessionStartTs) {
    const time_t nowTs = nowUnix();
    if (nowTs) {
      sessionStartTs = nowTs - (time_t)((now - sessionStartMs) / 1000UL);
      enqueuePresence(nowTs, sessionStartTs);
      Serial.println("[live] clock synced mid-session - start marker sent");
    }
  }

  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {  // presence due?
    lastHeartbeatMs = now;                      // reset the timer
    // While a session is running the beat re-asserts the live marker, so a long
    // detection is never wiped by an idle heartbeat; otherwise it sends null.
    const time_t nowTs = nowUnix();
    time_t since = 0;
    if (sessionActive && nowTs) {
      since = sessionStartTs ? sessionStartTs
                             : nowTs - (time_t)((now - sessionStartMs) / 1000UL);
    }
    enqueuePresence(nowTs, since);              // one tiny PATCH
    Serial.printf("[hb] pin=%s session=%d\n", level ? "HIGH" : "LOW", sessionActive ? 1 : 0); // ground truth on serial
  }

  // Send new events straight away; retry pending ones every RETRY_MS.
  if (qCount > 0 && (flushRequested || now - lastRetryMs >= RETRY_MS)) {
    flushRequested = false;                     // handled in this pass
    lastRetryMs    = now;                       // reset the retry timer
    if (WiFi.status() != WL_CONNECTED) connectWifi(); // kick a background connect
    if (WiFi.status() == WL_CONNECTED) {        // only when online
      syncTime();                               // arm the clock (background)
      flushQueue();                             // push everything waiting
    }
  }

  // Say once that the background clock sync landed (timestamps are real now).
  static bool ntpReported = false;
  if (!ntpReported && nowUnix() > 0) {
    ntpReported = true;
    Serial.println("[ntp] ok (background)");
  }

  // Report the first successful association after a (re)connect attempt.
  const bool onlineNow = (WiFi.status() == WL_CONNECTED);
  if (onlineNow && !wasOnline) {                // just came online
    wasOnline = true;                           // remember it
    logWifiResult();                            // log the assigned IP
  } else if (!onlineNow) {
    wasOnline = false;                          // ready for the next transition
  }

  // Silence while the radio claims to be online means the request path is stuck
  // (a dropped TLS session used to leave the board mute for minutes). Restarting
  // costs at most the interval in progress and puts the dashboard back on truth.
  // Signed on purpose: flushQueue() stamps lastUploadOkMs with a newer millis()
  // than the `now` above, so an unsigned difference here would look enormous.
  const int32_t silentMs = (int32_t)(millis() - lastUploadOkMs);
  if (WiFi.status() == WL_CONNECTED && silentMs > (int32_t)WATCHDOG_MS) {
    Serial.printf("[watchdog] no upload for %lus, heap %u - restarting\n",
                  (unsigned long)(silentMs / 1000L), ESP.getFreeHeap());
    delay(50);                                  // let the line flush
    ESP.restart();                              // fresh radio, fresh TLS stack
  }

  // Stay awake on purpose: the CPU keeps the interrupt live for every edge, and
  // the idle time in this delay() lets the ESP32's modem sleep doze the radio
  // between DTIM beacons while the Wi-Fi association stays intact.
  delay(20);                                    // edges are safe in the ISR
}
