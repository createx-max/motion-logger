/*
 * Motion logger 
 * ----------------------------------------------------------
 *  *
 *   PIR  VCC  -> ESP32 VIN  (5 V, only valid while powered over USB)
 *   PIR  GND  -> ESP32 GND
 *   PIR  OUT  -> ESP32 GPIO14
 *   LED  +    -> PIR OUT    (through a 220-330 ohm resistor)
 *   LED  -    -> PIR GND
 *
 * The sketch reads OUT, turns every "light on" interval into a session and
 * writes it to Supabase through the motion_event() RPC:
 *
 *   start -> inserts a row with started_at
 *   stop  -> sets ended_at
 *   ping  -> heartbeat, refreshes devices.last_seen_at
 *
 * Events that cannot be sent (no Wi-Fi / timeout) are queued in RAM and
 * retried, so short outages do not lose intervals.
 *
 * Board: "ESP32 Dev Module"  |  Port: COM7  |  Serial monitor: 115200 baud
 * Needs: Arduino IDE + "esp32 by Espressif" board package (Boards Manager).
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>

#include "secrets.h"   // WIFI_SSID, WIFI_PASSWORD, SUPABASE_URL, SUPABASE_ANON_KEY, DEVICE_KEY

// ---------------------------------------------------------------- settings
static const int      PIR_PIN        = 14;    // PIR OUT
static const int      STATUS_LED_PIN = -1;    // optional extra LED on a free GPIO, -1 = unused

static const uint32_t HOLD_MS      = 2000UL;            // OUT must stay LOW this long to close a session
static const uint32_t MAX_OPEN_MS  = 30UL * 60UL * 1000UL;  // safety: force-close after 30 min
static const uint32_t HEARTBEAT_MS = 30UL * 1000UL;         // "ping" cadence (dashboard calls offline after 2 min)
static const uint32_t RETRY_MS     = 15000UL;           // retry cadence when offline

// ---------------------------------------------------------------- queue
static const uint8_t Q_SIZE = 24;

struct Pending {
  char    event[6];
  time_t  ts;   // 0 = let the server stamp it
};

static Pending  queue[Q_SIZE];
static uint8_t  qHead  = 0;
static uint8_t  qCount = 0;

// ---------------------------------------------------------------- state
static bool     sessionActive  = false;
static uint32_t sessionStartMs = 0;
static uint32_t lastHighMs     = 0;
static time_t   sessionStartTs = 0;
static uint32_t lastHeartbeatMs = 0;
static uint32_t lastRetryMs     = 0;
static bool     flushRequested  = true;

// ---------------------------------------------------------------- helpers
static String isoUtc(time_t t) {
  struct tm tmUtc;
  gmtime_r(&t, &tmUtc);
  char buf[24];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmUtc);
  return String(buf);
}

static time_t nowUnix() {
  time_t t = time(nullptr);
  return (t > 1700000000) ? t : 0;   // 0 -> clock not synced yet
}

static void setStatusLed(bool on) {
  if (STATUS_LED_PIN >= 0) digitalWrite(STATUS_LED_PIN, on ? HIGH : LOW);
}

static void enqueue(const char *event, time_t ts) {
  if (qCount >= Q_SIZE) {                 // drop the oldest to keep the newest
    qHead = (uint8_t)((qHead + 1) % Q_SIZE);
    qCount--;
  }
  uint8_t slot = (uint8_t)((qHead + qCount) % Q_SIZE);
  strncpy(queue[slot].event, event, sizeof(queue[slot].event) - 1);
  queue[slot].event[sizeof(queue[slot].event) - 1] = '\0';
  queue[slot].ts = ts;
  qCount++;
  flushRequested = true;
  Serial.printf("[queue] %-5s ts=%s (pending %u)\n", event,
                ts ? isoUtc(ts).c_str() : "server", qCount);
}

static bool postEvent(const char *event, time_t ts) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();          // no CA bundle needed; traffic is still TLS

  HTTPClient http;
  http.setConnectTimeout(6000);
  http.setTimeout(8000);

  String url = String(SUPABASE_URL) + "/rest/v1/rpc/motion_event";
  if (!http.begin(client, url)) {
    Serial.println("[http] begin() failed");
    return false;
  }
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "application/json");

  String body = String("{\"p_device_key\":\"") + DEVICE_KEY +
                "\",\"p_event\":\"" + event + "\",\"p_ts\":";
  body += ts ? ("\"" + isoUtc(ts) + "\"") : String("null");
  body += "}";

  int code = http.POST(body);
  bool ok  = (code >= 200 && code < 300);

  if (!ok) {
    String reply = http.getString();
    if (reply.length() > 160) reply = reply.substring(0, 160);
    Serial.printf("[http] %s -> %d %s\n", event, code, reply.c_str());
    if (code == 401 || code == 404) {
      Serial.println("[http] check SUPABASE_ANON_KEY and the motion_event() function");
    } else if (code >= 400 && reply.indexOf("unknown device key") >= 0) {
      Serial.println("[http] check DEVICE_KEY");
    }
  }
  http.end();
  return ok;
}

static void flushQueue() {
  while (qCount > 0) {
    Pending &p = queue[qHead];
    if (!postEvent(p.event, p.ts)) return;        // keep it, retry later
    Serial.printf("[sync] %s ok\n", p.event);
    qHead = (uint8_t)((qHead + 1) % Q_SIZE);
    qCount--;
  }
}

static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000UL) {
    delay(400);
    Serial.print('.');
  }
  Serial.println(WiFi.status() == WL_CONNECTED
                   ? " ok " + WiFi.localIP().toString()
                   : " failed (will retry)");
}

static void syncTime() {
  if (nowUnix() > 0) return;
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.print("[ntp] syncing");
  uint32_t start = millis();
  while (nowUnix() == 0 && millis() - start < 15000UL) {
    delay(400);
    Serial.print('.');
  }
  Serial.println(nowUnix() ? " ok" : " failed (server will stamp times)");
}

// ---------------------------------------------------------------- setup
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("=== motion logger booting ===");

  pinMode(PIR_PIN, INPUT);
  if (STATUS_LED_PIN >= 0) pinMode(STATUS_LED_PIN, OUTPUT);
  setStatusLed(false);

  connectWifi();
  syncTime();

  lastHeartbeatMs = millis();
  Serial.println("[pir] warming up - give the sensor ~60 s to settle");
  Serial.println("[boot] done, watching GPIO14");
}

// ---------------------------------------------------------------- loop
void loop() {
  const uint32_t now = millis();
  const int      pir = digitalRead(PIR_PIN);

  if (!sessionActive) {
    if (pir == HIGH) {
      sessionActive  = true;
      sessionStartMs = now;
      lastHighMs     = now;
      sessionStartTs = nowUnix();
      setStatusLed(true);
      Serial.println("[motion] START");
      enqueue("start", sessionStartTs);
    }
  } else {
    if (pir == HIGH) lastHighMs = now;

    const uint32_t held  = now - lastHighMs;
    const uint32_t total = now - sessionStartMs;

    if (held > HOLD_MS || total > MAX_OPEN_MS) {
      // the light went off when the signal last dropped, not now
      time_t endTs = sessionStartTs ? sessionStartTs + (time_t)((lastHighMs - sessionStartMs) / 1000UL)
                                    : 0;
      if (sessionStartTs && endTs <= sessionStartTs) endTs = sessionStartTs + 1;

      Serial.printf("[motion] STOP after %lu s\n", (unsigned long)(total / 1000UL));
      enqueue("stop", endTs);

      sessionActive  = false;
      sessionStartTs = 0;
      setStatusLed(false);
    }
  }

  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
    lastHeartbeatMs = now;
    enqueue("ping", 0);
  }

  // Send new events straight away; retry pending ones every RETRY_MS.
  if (qCount > 0 && (flushRequested || now - lastRetryMs >= RETRY_MS)) {
    flushRequested = false;
    lastRetryMs    = now;
    if (WiFi.status() != WL_CONNECTED) connectWifi();
    if (WiFi.status() == WL_CONNECTED) {
      syncTime();
      flushQueue();
    }
  }

  delay(50);
}
