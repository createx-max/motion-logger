/*
 * Scintal Sense Data Logger V3 — ESP32 firmware
 * ----------------------------------------------------------
 * Wiring
 *   SENSOR  VCC  -> ESP32 VIN  (5 V, only valid while powered over USB)
 *   SENSOR  GND  -> ESP32 GND
 *   SENSOR  OUT  -> ESP32 GPIO14
 *   LED  +    -> SENSOR OUT    (through a 220-330 ohm resistor)
 *   LED  -    -> SENSOR GND
 *
 * What it does
 *   Reads the SENSOR output and turns every "light on" period into one row in
 *   Supabase, using the motion_event() database function:
 *
 *     start -> inserts a row and stamps started_at
 *     stop  -> closes that row by stamping ended_at
 *     ping  -> heartbeat; refreshes devices.last_seen_at so the dashboard
 *              can tell ON from OFF
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

// GPIO wired to the  OUT pin.
static const int      SENSOR_PIN        = 14;

// Optional extra LED on a free GPIO; -1 means "not fitted".
static const int      STATUS_LED_PIN = -1;

// The signal must stay LOW this long before we call the light "off".
static const uint32_t HOLD_MS      = 2000UL;

// Safety valve: never let one session run longer than 30 minutes.
static const uint32_t MAX_OPEN_MS  = 30UL * 60UL * 1000UL;

// Heartbeat cadence; the dashboard treats 60 s of silence as device OFF,
// so four missed pings inside a minute are enough to notice a power cut.
static const uint32_t HEARTBEAT_MS = 15UL * 1000UL;

// How often a stuck queue is retried while offline.
static const uint32_t RETRY_MS     = 15000UL;

// ---------------------------------------------------------------- queue

// How many unsent events we remember (oldest is dropped when full).
static const uint8_t Q_SIZE = 24;

// One waiting event.
struct Pending {
  char    event[6]; // "start", "stop" or "ping" (+ terminator)
  time_t  ts;       // when it happened; 0 = let the server stamp it
};

// The ring buffer itself plus its head index and item count.
static Pending  queue[Q_SIZE];
static uint8_t  qHead  = 0; // index of the oldest item
static uint8_t  qCount = 0; // how many items are waiting

// ---------------------------------------------------------------- state

// True while the SENSOR output is being logged as one open session.
static bool     sessionActive  = false;

// millis() at which the current session started.
static uint32_t sessionStartMs = 0;

// millis() of the most recent HIGH reading (the true "light went off" moment).
static uint32_t lastHighMs     = 0;

// UTC timestamp of the session start; 0 when the clock was not synced yet.
static time_t   sessionStartTs = 0;

// millis() of the last heartbeat we queued.
static uint32_t lastHeartbeatMs = 0;

// millis() of the last delivery attempt.
static uint32_t lastRetryMs     = 0;

// Set when something new is queued, so it is sent without waiting for RETRY_MS.
static bool     flushRequested  = true;

// ---------------------------------------------------------------- helpers

// Convert a UTC timestamp into the ISO-8601 text Postgres accepts.
static String isoUtc(time_t t) {
  struct tm tmUtc;                              // broken-down UTC time
  gmtime_r(&t, &tmUtc);                         // fill it from the timestamp
  char buf[24];                                 // "2026-11-14T18:42:07Z" + terminator
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmUtc); // format it
  return String(buf);                           // hand back as String
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

// Put one event at the back of the queue.
static void enqueue(const char *event, time_t ts) {
  if (qCount >= Q_SIZE) {                       // queue full?
    qHead = (uint8_t)((qHead + 1) % Q_SIZE);    // drop the oldest event
    qCount--;                                   // keep the count honest
  }
  uint8_t slot = (uint8_t)((qHead + qCount) % Q_SIZE); // where the new one goes
  strncpy(queue[slot].event, event, sizeof(queue[slot].event) - 1); // copy the name
  queue[slot].event[sizeof(queue[slot].event) - 1] = '\0';         // always terminate
  queue[slot].ts = ts;                          // remember when it happened
  qCount++;                                     // one more waiting
  flushRequested = true;                        // try to send it on this loop
  Serial.printf("[queue] %-5s ts=%s (pending %u)\n", event,
                ts ? isoUtc(ts).c_str() : "server", qCount); // log it
}

// POST one event to Supabase. Returns true only on a 2xx reply.
static bool postEvent(const char *event, time_t ts) {
  if (WiFi.status() != WL_CONNECTED) return false; // no network, nothing to try

  WiFiClientSecure client;                      // TLS socket for this request
  client.setInsecure();                         // no CA bundle on the device; traffic is still encrypted

  HTTPClient http;                              // request object
  http.setConnectTimeout(6000);                 // give up connecting after 6 s
  http.setTimeout(8000);                        // and after 8 s of no answer

  String url = String(SUPABASE_URL) + "/rest/v1/rpc/motion_event"; // the database function
  if (!http.begin(client, url)) {               // open the connection
    Serial.println("[http] begin() failed");    // bad URL or out of memory
    return false;
  }
  http.addHeader("apikey", SUPABASE_ANON_KEY);                          // Supabase key header
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY); // and the bearer header
  http.addHeader("Content-Type", "application/json");                  // we send JSON

  String body = String("{\"p_device_key\":\"") + DEVICE_KEY +          // which device
                "\",\"p_event\":\"" + event + "\",\"p_ts\":";          // which event, then the time
  body += ts ? ("\"" + isoUtc(ts) + "\"") : String("null");            // real timestamp or null
  body += "}";                                                         // close the JSON

  int code = http.POST(body);                   // send it
  bool ok  = (code >= 200 && code < 300);       // 2xx means stored

  if (!ok) {                                    // explain the failure on serial
    String reply = http.getString();            // server's message
    if (reply.length() > 160) reply = reply.substring(0, 160); // keep it short
    Serial.printf("[http] %s -> %d %s\n", event, code, reply.c_str()); // log it
    if (code == 401 || code == 404) {           // auth or missing function
      Serial.println("[http] check SUPABASE_ANON_KEY and the motion_event() function");
    } else if (code >= 400 && reply.indexOf("unknown device key") >= 0) {
      Serial.println("[http] check DEVICE_KEY"); // wrong device key in secrets.h
    }
  }
  http.end();                                   // close the connection
  return ok;                                    // tell the caller
}

// Send everything waiting, stopping at the first failure.
static void flushQueue() {
  while (qCount > 0) {                          // as long as something is pending
    Pending &p = queue[qHead];                  // oldest item
    if (!postEvent(p.event, p.ts)) return;      // failed: keep it, retry later
    Serial.printf("[sync] %s ok\n", p.event);   // delivered
    qHead = (uint8_t)((qHead + 1) % Q_SIZE);    // move the head forward
    qCount--;                                   // one fewer waiting
  }
}

// Join the Wi-Fi network, waiting up to 20 s.
static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;    // already online
  Serial.printf("[wifi] connecting to %s", WIFI_SSID); // log the network name
  WiFi.mode(WIFI_STA);                          // station mode (client, not access point)
  WiFi.setAutoReconnect(true);                  // let the stack retry on its own
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);         // start connecting

  uint32_t start = millis();                    // timeout reference
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000UL) { // wait up to 20 s
    delay(400);                                 // do not spin the CPU
    Serial.print('.');                          // progress dots
  }
  Serial.println(WiFi.status() == WL_CONNECTED
                   ? " ok " + WiFi.localIP().toString()  // show the assigned IP
                   : " failed (will retry)");            // or admit failure
}

// Sync the clock over NTP; the timestamps depend on it.
static void syncTime() {
  if (nowUnix() > 0) return;                    // already have a sane time
  configTime(0, 0, "pool.ntp.org", "time.google.com"); // UTC, two public servers
  Serial.print("[ntp] syncing");                // progress note
  uint32_t start = millis();                    // timeout reference
  while (nowUnix() == 0 && millis() - start < 15000UL) { // wait up to 15 s
    delay(400);                                 // breathe
    Serial.print('.');                          // progress dots
  }
  Serial.println(nowUnix() ? " ok" : " failed (server will stamp times)"); // result
}

// ---------------------------------------------------------------- setup

// Runs once after reset or power-on.
void setup() {
  Serial.begin(115200);                         // open the serial monitor link
  delay(300);                                   // let it settle
  Serial.println();                             // blank line
  Serial.println("=== motion logger booting ==="); // banner

  pinMode(SENSOR_PIN, INPUT);                      // SENSOR OUT is an input to us
  if (STATUS_LED_PIN >= 0) pinMode(STATUS_LED_PIN, OUTPUT); // optional LED is an output
  setStatusLed(false);                          // start with the LED off

  connectWifi();                                // join the network first
  syncTime();                                   // then set the clock

  lastHeartbeatMs = millis();                   // first heartbeat is due 30 s from now
  Serial.println("[SENSOR] warming up - give the sensor ~60 s to settle"); // SENSOR needs time
  Serial.println("[boot] done, watching GPIO14"); // ready
}

// ---------------------------------------------------------------- loop

// Runs forever, several times per second.
void loop() {
  const uint32_t now = millis();                // current uptime in ms
  const int      SENSOR = digitalRead(SENSOR_PIN);    // HIGH = motion, LED lit

  if (!sessionActive) {
    if (SENSOR == HIGH) {                          // motion started
      sessionActive  = true;                    // open a session
      sessionStartMs = now;                     // remember when
      lastHighMs     = now;                     // last confirmed HIGH
      sessionStartTs = nowUnix();               // real clock time, 0 if not synced
      setStatusLed(true);                       // mirror the state on the LED
      Serial.println("[motion] START");         // log it
      enqueue("start", sessionStartTs);         // tell the server
    }
  } else {
    if (SENSOR == HIGH) lastHighMs = now;          // still detecting: keep the end time fresh

    const uint32_t held  = now - lastHighMs;    // time since the last HIGH
    const uint32_t total = now - sessionStartMs; // how long this session has run

    if (held > HOLD_MS || total > MAX_OPEN_MS) { // long enough LOW, or hit the 30 min cap
      // the light went off when the signal last dropped, not now
      time_t endTs = sessionStartTs ? sessionStartTs + (time_t)((lastHighMs - sessionStartMs) / 1000UL)
                                    : 0;        // exact end = start + time held HIGH
      if (sessionStartTs && endTs <= sessionStartTs) endTs = sessionStartTs + 1; // never zero-length

      Serial.printf("[motion] STOP after %lu s\n", (unsigned long)(total / 1000UL)); // log the length
      enqueue("stop", endTs);                   // close the row on the server

      sessionActive  = false;                   // ready for the next motion
      sessionStartTs = 0;                       // clear the start stamp
      setStatusLed(false);                      // LED off
    }
  }

  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {  // heartbeat due?
    lastHeartbeatMs = now;                      // reset the timer
    enqueue("ping", 0);                         // server stamps the time itself
  }

  // Send new events straight away; retry pending ones every RETRY_MS.
  if (qCount > 0 && (flushRequested || now - lastRetryMs >= RETRY_MS)) {
    flushRequested = false;                     // handled in this pass
    lastRetryMs    = now;                       // reset the retry timer
    if (WiFi.status() != WL_CONNECTED) connectWifi(); // try to get back online
    if (WiFi.status() == WL_CONNECTED) {        // only when online
      syncTime();                               // make sure the clock is right
      flushQueue();                             // push everything waiting
    }
  }

  delay(50);                                    // small pause, keeps the loop cheap
}
