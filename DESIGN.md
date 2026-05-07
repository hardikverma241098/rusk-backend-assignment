# DESIGN.md — Streaming Platform Backend Refactor

---

## 1. What I Identified in the Original Code

### 1.1 Sequential side effects blocking client responses
Every handler awaited push, analytics, CRM, email, and revenue calls one after another before responding. These are non-critical side effects — their outcome has no bearing on whether the user was created or the purchase was recorded. A single slow or degraded third-party service (CRM taking 2s) made every signup on the platform slow simultaneously.

### 1.2 No event-driven decoupling
All downstream integrations were hardcoded into the HTTP handler. Adding a new integration meant modifying the handler. There was no separation between "what happened" and "what to do about it."

### 1.3 The watch endpoint had no scale strategy
The comment in the original code says it all: *~2,000 concurrent viewers, every 30 seconds.* That's ~67 req/s. Each request was doing a synchronous DB write + outbound HTTP call. At 1M users (the realistic growth target) this becomes 33,333 DB writes/second — a number that would collapse any database. More critically, every heartbeat was being stored individually when only the latest position per user ever matters for the resume feature.

### 1.4 No input validation
No handler validated its inputs. Missing fields caused silent bad DB writes or unhandled runtime crashes.

### 1.5 DB errors unhandled
`saveUserToDB` and `savePurchaseToDB` were awaited without try-catch. A DB failure would propagate as an unhandled rejection. In the purchase handler this is a billing integrity problem — side effects could execute for a purchase that was never persisted.

### 1.6 No idempotency on purchase
No protection against double execution — client retries on timeout, network blips, double-clicks. Same purchase could be written twice.

### 1.7 No structured logging or request tracing
Unstructured console.log is not queryable in production. No requestId means no way to trace a user complaint through the system.

### 1.8 No graceful shutdown
In Kubernetes, rolling deploys send SIGTERM before killing a pod. Without a shutdown handler, in-flight requests and buffered events are dropped silently.

---

## 2. Scale Analysis

### Current load (2,000 concurrent users)
```
2,000 users × 1 heartbeat/30s = ~67 req/s
Original approach: 67 DB writes/s + 67 HTTP calls/s
→ Manageable but wasteful. Every write is throwaway data.
```

### Target load (1,000,000 concurrent users)
```
1,000,000 users × 1 heartbeat/30s = ~33,333 req/s

Without optimization:
  33,333 DB writes/s → any relational DB collapses. MongoDB struggles.

With Kafka + Redis layer (this implementation):
  33,333 Kafka publishes/s     → Kafka handles millions/s, no issue
  33,333 Redis SETMAX ops/s   → Redis handles 100K–1M ops/s, no issue
  DB writes via flush job:
    1,000,000 records / 300s  → ~3,333 writes/s as bulk upsert
    → 10x reduction in DB pressure, done in a handful of round-trips

Kafka partitioning for 1M users:
  100 partitions on watch.heartbeat topic
  → 333 msg/s per partition (trivial)
  → 100 consumer instances in watch-progress-writer group
  → linear horizontal scaling
```

### Signup and purchase load
These are inherently low-frequency (hundreds/s at most, not thousands). Kafka adds durability for side effects, not raw throughput. The bottleneck here will always be DB writes and third-party integrations, not the event bus.

---

## 3. Architecture

### Event flow

**User Signup:**
```
POST /user/signup
  → validate
  → userRepo.save()           ← critical, must succeed
  → producer.publish(user.signed_up)
  → respond 201

Consumers (async, decoupled):
  notification-service  → push notification
  analytics-service     → track signup event
  crm-service           → sync contact to CRM
```

**Purchase:**
```
POST /purchase/complete
  → validate
  → Redis SETNX idempotency check
  → purchaseRepo.save()       ← critical
  → producer.publish(purchase.completed)
  → respond 200

Consumers:
  notification-service  → push notification
  revenue-service       → capture revenue + send confirmation email
  crm-service           → trigger upsell campaign
  analytics-service     → track purchase event
```

**Watch Heartbeat:**
```
POST /watch/event
  → validate
  → producer.publish(watch.heartbeat, partitionKey=userId)
  → respond 200              ← ~2ms total

Consumer: watch-progress-writer
  → eachBatch: Redis SETMAX watch:progress:{userId}:{contentId}
  → completion detection: if watchedSeconds >= 95% → mark completed

Flush job (every 5 mins):
  → Redis SCAN watch:progress:*
  → bulk UPSERT to DB with GREATEST logic

Consumer: analytics-service
  → raw append every heartbeat to analytics store (Clickhouse/BigQuery)
```

---

## 4. Watch Endpoint — Deep Dive

### Why not store every heartbeat to DB?

The only reason watch progress exists in the DB is to power the **resume feature**: "continue watching from where you left off." For this, you need exactly one value per `(userId, contentId)` — the furthest point reached.

A user watching a 1-hour video generates 120 heartbeats. Of those, 119 are irrelevant the moment the next one arrives. Storing all 120 to the DB is pure waste at any scale.

What we actually store: `maxWatchedSeconds` — the furthest point the user has ever reached for that content.

### lastWatchedSeconds vs maxWatchedSeconds vs resumePosition

These are three different things:

- `lastWatchedSeconds`: the most recent heartbeat value. Unreliable as resume point — if user seeks back to rewatch a scene, the last heartbeat is lower than where they actually were.
- `maxWatchedSeconds`: the furthest point ever reached. Used as the resume position. Protects against seek-back confusion.
- `resumePosition`: what we show the user. Equals `maxWatchedSeconds` unless content is marked `completed`, in which case it resets to 0 (user explicitly finished — offer to watch again from beginning).

This implementation stores `maxWatchedSeconds` and uses Redis SETMAX to ensure it only ever increases.

### Multi-device consistency

Problem: user watches on mobile to 30 mins, opens laptop, starts rewatching from 0.

```
Mobile heartbeat:  watchedSeconds=1800  → SETMAX: Redis key = 1800 ✅
Laptop heartbeat:  watchedSeconds=300   → SETMAX: 300 < 1800, no update ✅
Resume on any device: 30 mins ✅
```

The SETMAX operation is atomic — implemented as a Redis Lua script in production:

```lua
local cur = redis.call('GET', KEYS[1])
if not cur or cjson.decode(cur).maxWatchedSeconds < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 0
```

Atomicity is critical here. A read-then-write in application code has a race condition between two concurrent device updates.

### Abrupt tab close / mobile app kill

Last heartbeat fired at 28:00. User was at 29:50 when they force-closed.

Up to 30 seconds of progress is lost. This is accepted. Mitigation on the client side:

```javascript
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('/watch/event', lastKnownPayload);
});
```

`sendBeacon` fires even when the tab is closing, unlike regular fetch. On mobile, app lifecycle events (`UIApplicationWillTerminateNotification` on iOS, `onStop()` on Android) should also trigger a final heartbeat. Neither is perfectly reliable under all conditions (battery kill, force-quit). The 30s loss is an acceptable product trade-off for a streaming platform — it is not acceptable for a payment system.

### Out-of-order Kafka messages

Partitioning by `userId` ensures all heartbeats for a user land on the same Kafka partition — ordered by default. Out-of-order delivery is therefore not expected in steady state.

However, the DB upsert uses `GREATEST` as a safety net:

```sql
ON CONFLICT (user_id, content_id)
DO UPDATE SET
  max_watched_seconds = GREATEST(watch_progress.max_watched_seconds, excluded.max_watched_seconds),
  updated_at = excluded.updated_at
WHERE excluded.updated_at > watch_progress.updated_at;
```

This also protects the flush job: if two flush cycles run in quick succession (e.g., shutdown flush right after a regular flush), the DB write is always safe.

### Video completion

When `watchedSeconds >= contentDuration * 0.95`, the content is marked as completed in Redis (30-day retention). The 95% threshold accounts for users who skip credits or close slightly before the end.

On resume: if content is completed, the client receives `completed: true` and offers "Watch again" (resume from 0) instead of "Continue watching" (resume from maxWatchedSeconds).

### Redis TTL strategy

TTL is set to 24 hours and refreshed on every heartbeat update (including no-ops where the value didn't change). The flush job runs every 5 minutes.

```
Flush interval (5 min) << Redis TTL (24 hr)
```

This ensures: even if a user pauses for hours, their Redis key survives and the flush job will persist their progress long before TTL expires. If a user is inactive for more than 24 hours, the key expires — but by then the flush job will have written their progress to the DB multiple times.

---

## 5. What I Changed and Why

### Layered architecture
Handlers are thin — parse, validate, delegate, respond. Services own business logic. Repositories own DB access. Events own publishing. Each layer is independently testable and replaceable.

### Kafka for all side effects
Adding a new downstream integration is a new consumer file. The handler never changes. This is the open/closed principle applied to distributed systems.

On the mock: `config/kafka.js` backs the Kafka client with an in-process EventEmitter that mirrors the kafkajs API exactly. Swapping to a real broker is changing one file. Nothing else in the codebase changes.

### Redis idempotency on purchase
Atomic SETNX with 24h TTL. Works correctly across multiple service instances when backed by real Redis. The mock is per-process only — documented as a deployment requirement.

### Pino structured logging with requestId
Every log line is structured JSON. A unique requestId is attached to every request and propagated through logs. In production, this means any user complaint can be traced end-to-end across handler → service → consumer in Datadog or Loki.

### Graceful shutdown
On SIGTERM: stop accepting connections → final Redis flush → DB upsert → Kafka disconnect → exit. Rolling deploys do not lose watch progress.

---

## 6. Trade-offs Consciously Made

**No retry logic on consumers.** If a consumer handler throws, the error is logged but the message is not retried. Production needs: exponential backoff retry + dead-letter topic for permanently failed messages. Deferred because it adds significant complexity and is not essential for a first-pass refactor.

**In-process Kafka and Redis mocks.** No real broker or cache. The interfaces are production-identical — infrastructure is swapped by changing one config file each.

**Flush job runs in-process.** The watch flush job runs as a setInterval inside the service. In production at scale, this should be an independent worker process or a Kubernetes CronJob — so it can scale independently and doesn't consume service resources.

**No content duration in DB.** Completion detection relies on `contentDuration` being sent in the heartbeat payload from the client. In production, this should be fetched from a content metadata service (with Redis caching) rather than trusted from the client.

**Composite fallback idempotency key on purchase.** `userId:planId` as fallback is a heuristic — it would incorrectly deduplicate if a user legitimately re-purchases the same plan after cancellation. Clients must send an explicit `Idempotency-Key` header.

**No rate limiting.** A viewer sending heartbeats every second instead of every 30 would generate 30x expected Kafka volume. A per-userId token bucket limiter belongs in an API gateway layer.

---

## 7. Remaining Gaps

**Consumer dead-letter handling.** Failed consumer messages are logged and dropped. Production requires: retry with exponential backoff, dead-letter topic for exhausted retries, alerting when DLT is non-empty. The revenue consumer especially — a failed revenue capture must never go silently unnoticed.

**Flush job failure leaves progress in limbo.** If `watchFlushJob` fails to upsert to DB, those Redis entries are already deleted (getdel). In production: write failed records back to a Redis dead-letter set, alert on non-empty dead-letter set, retry on next flush cycle.

**Distributed idempotency requires real Redis.** The in-memory Redis mock is per-process. Two service instances running simultaneously will not share idempotency state. Real Redis is a hard deployment requirement before horizontal scaling.

**No observability.** Missing: Prometheus metrics (request latency P50/P95/P99, Kafka consumer lag, Redis hit rate, flush job duration and record count), distributed tracing (OpenTelemetry), alerting. Key signals to monitor: watch.heartbeat consumer lag (growing lag = consumers falling behind), flush job error rate, Redis memory usage.

**Kafka topic configuration.** Production topics need explicit partition counts and replication factors. For `watch.heartbeat` at 1M users: 100 partitions, replication factor 3, retention 24h (heartbeats are transient — no need for long retention). Partition count determines max consumer parallelism and should be provisioned ahead of expected peak.

**sendBeacon reliability on mobile.** The recommended client-side mitigation for abrupt close is not reliable under all mobile conditions. For higher resume accuracy, consider client-side local storage of last known position with server reconciliation on next open — the client sends "I was at X when I last closed" and the server takes the max of that and its stored value.

**Authentication and authorization.** Not implemented — assumed to be handled at API gateway. In production, every endpoint needs JWT validation and the watch endpoint should verify the user owns the content they're reporting progress on.
