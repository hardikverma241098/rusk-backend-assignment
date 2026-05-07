# DESIGN.md — Streaming Platform Backend Refactor

---

## 1. What I Identified in the Original Code

### Sequential side effects blocking client responses
Every handler awaited push, analytics, CRM, email, and revenue calls one after another before responding. These are non-critical side effects — their outcome has no bearing on whether a user was created or a purchase was recorded. A single slow third-party service made every signup on the platform slow simultaneously. If the CRM was timing out at 2s, every user signup took 2s+ regardless of how fast the DB write was.

### No event-driven decoupling
All downstream integrations were hardcoded into the HTTP handler. Adding a new integration meant modifying the handler directly. There was no separation between "what happened" and "what to do about it."

### The watch endpoint had no scale strategy
The original code's own comment says: *~2,000 concurrent viewers, every 30 seconds.* That's ~67 req/s. Each request did a synchronous DB write and an outbound HTTP call to analytics. At 1M users — a realistic growth target for a media platform — this becomes 33,333 DB writes/second, a number that collapses any database. More critically, every heartbeat was being individually stored when only the latest position per user ever matters for the resume feature.

### No input validation
No handler validated its inputs before processing. A missing `userId` or a non-numeric `amount` caused a silent bad DB write or an unhandled runtime crash with no meaningful response to the client.

### DB errors completely unhandled
`saveUserToDB` and `savePurchaseToDB` were awaited without try-catch. In the purchase handler this is a billing integrity problem — side effects could execute for a purchase that was never actually persisted in the DB.

### No idempotency on the purchase endpoint
No protection against double execution — client retries on network timeout, double-clicks, or frontend retries could write the same purchase twice.

### No structured logging or request tracing
Unstructured `console.log` strings are not queryable in production. No requestId meant no way to trace a user complaint end-to-end through the system.

### No graceful shutdown
In Kubernetes, rolling deploys send SIGTERM before killing a pod. Without a shutdown handler, in-flight requests and buffered data drop silently.

---

## 2. Scale Analysis

### Original load (2,000 concurrent users)
```
2,000 users × 1 heartbeat / 30s = ~67 req/s

Original approach:
  67 DB writes/s  (every heartbeat stored individually)
  67 HTTP calls/s (analytics on every request)
  → Wasteful. 66 of every 67 DB writes are throwaway data.
```

### Target load (1,000,000 concurrent users)
```
1,000,000 users × 1 heartbeat / 30s = ~33,333 req/s

Without optimization:
  33,333 DB writes/s → any relational DB collapses under this

With this architecture:
  33,333 Kafka publishes/s    → Kafka is built for millions/s, no issue
  33,333 Redis SETMAX ops/s  → Redis handles 100K–1M ops/s, no issue
  DB writes via flush job:
    1,000,000 records / 300s → ~3,333 writes/s as a single bulk upsert
    → 10x reduction in DB write pressure
    → done in a handful of DB round-trips per flush cycle
```

### Kafka partitioning at 1M users
```
watch.heartbeat topic: 100 partitions
  → 333 msg/s per partition (trivial per partition)
  → 100 consumer instances in watch-progress-writer group
  → linear horizontal scaling — add partitions and consumers together
```

### Signup and purchase load
Inherently low frequency — hundreds per second at most. Kafka here adds durability for side effects, not raw throughput. The bottleneck will always be DB writes and third-party API latency, not the event bus.

---

## 3. Architecture

### Event flow — User Signup
```
POST /user/signup
  → validate inputs
  → userRepo.save()                     ← critical path, must succeed
  → producer.publish('user.signed_up')  ← Kafka, partitioned by userId
  → respond 201

Consumers (async, fully decoupled):
  notification-service  → push notification
  analytics-service     → track signup event
  crm-service           → sync contact to CRM
```

### Event flow — Purchase
```
POST /purchase/complete
  → validate inputs
  → Redis SETNX idempotency check       ← atomic, safe across instances
  → purchaseRepo.save()                 ← critical path
  → producer.publish('purchase.completed')
  → respond 200

Consumers:
  notification-service  → push notification
  revenue-service       → capture revenue + send confirmation email
  crm-service           → trigger post-purchase upsell campaign
  analytics-service     → track purchase event
```

### Event flow — Watch Heartbeat
```
POST /watch/event
  → validate inputs
  → producer.publish('watch.heartbeat', partitionKey=userId)
  → respond 200                         ← ~2ms total, no DB, no Redis in hot path

Consumer: watch-progress-writer
  → eachBatch: Redis SETMAX watch:progress:{userId}:{contentId}
  → completion check: watchedSeconds >= 95% of duration → set completed flag

Flush job (Kubernetes CronJob, every 5 mins):
  → Redis SCAN watch:progress:*
  → bulk UPSERT to DB with GREATEST semantics
  → restore Redis key if DB write fails (no silent data loss)

Consumer: analytics-service
  → raw append of every heartbeat to analytics store (Clickhouse/BigQuery)
  → analytics needs every event for engagement curves and drop-off analysis
  → NOT collapsed like the DB write path
```

---

## 4. Watch Endpoint — Deep Dive

### Why not store every heartbeat to DB

The only reason watch progress exists in the DB is to power the resume feature. For this, you need exactly one value per `(userId, contentId)` — the furthest point the user has ever reached. A user watching a 1-hour video generates 120 heartbeats over their session. Of those, 119 are irrelevant the moment the next one arrives.

What we store: `maxWatchedSeconds` — the furthest point ever reached. This is also the resume position.

### lastWatchedSeconds vs maxWatchedSeconds

These are different things and must be treated differently:

- `lastWatchedSeconds`: the most recent heartbeat value. Unreliable as resume point — if the user seeks back to rewatch a scene, the last heartbeat is lower than their actual furthest position.
- `maxWatchedSeconds`: the furthest point ever reached. This is the resume position.

Example: user watches to 50 mins, seeks back to 10 mins to rewatch a scene. `lastWatchedSeconds` = 600. `maxWatchedSeconds` = 3000. Resume should take them back to 50 mins, not 10 mins. We store and use `maxWatchedSeconds`.

### How many DB writes for a 50 min session
```
100 heartbeats total (every 30s for 50 mins)

100 Kafka messages published
100 Redis SETMAX operations (one per heartbeat, ~0.1ms each)
 10 DB writes via flush job (one per 5min flush cycle)

Each flush cycle collapses 10 heartbeats into 1 DB write.
The DB always receives only the latest maxWatchedSeconds.
```

### Multi-device consistency

Problem: user watches on mobile to 30 mins, opens laptop, starts rewatching from the beginning.

```
Mobile heartbeat:  watchedSeconds=1800 → SETMAX: Redis = 1800  ✅
Laptop heartbeat:  watchedSeconds=300  → SETMAX: 300 < 1800, no update ✅
Resume on any device → 30 mins ✅
```

The SETMAX operation must be atomic. A read-then-write in application code has a race condition between two concurrent device updates. In production this is a Redis Lua script:

```lua
local cur = redis.call('GET', KEYS[1])
if not cur or cjson.decode(cur).maxWatchedSeconds < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
redis.call('EXPIRE', KEYS[1], ARGV[3])  -- always refresh TTL on activity
return 0
```

### Abrupt tab close / mobile app kill

Last heartbeat fired at 28:00. User was at 29:50 when they force-closed. Up to 30 seconds of progress is lost. This is an accepted trade-off — it is not acceptable for a payment system but is acceptable for watch progress tracking.

Client-side mitigation:
```javascript
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('/watch/event', lastKnownPayload);
});
```

`sendBeacon` fires even during tab close, unlike regular fetch. On mobile, app lifecycle hooks (`onStop()` on Android, `applicationWillTerminate` on iOS) should also trigger a final heartbeat. Neither is perfectly reliable under all conditions (battery kill, force-quit). The 30s loss is the accepted floor.

### Out-of-order Kafka messages

Partitioning by `userId` ensures all heartbeats for a user land on the same Kafka partition — ordered by default. Out-of-order delivery is not expected in steady state.

As an additional safety net, the DB upsert uses MongoDB's `$max` operator which only updates the field if the new value is greater:

```javascript
// MongoDB bulk upsert — one round-trip for the entire batch
const ops = records.map(r => ({
  updateOne: {
    filter: { userId: r.userId, contentId: r.contentId },
    update: {
      $max: { maxWatchedSeconds: r.maxWatchedSeconds },
      $set: { sessionId: r.sessionId, updatedAt: r.updatedAt }
    },
    upsert: true
  }
}));
await WatchProgress.bulkWrite(ops);
```

This also protects against two flush cycles running in close succession writing the same records.

### Video completion

When `watchedSeconds >= contentDuration * 0.95`, the content is marked as completed in Redis with a 30-day TTL. The 95% threshold accounts for users who close before credits finish.

On resume: if `completed = true`, the client offers "Watch again" (resume from 0) instead of "Continue watching" (resume from `maxWatchedSeconds`).

### Redis TTL strategy

TTL is set to 24 hours and refreshed on every heartbeat update — including no-ops where the value didn't change. The flush job runs every 5 minutes.

```
Flush interval (5 min) must always be << Redis TTL (24 hrs)
```

This guarantees: even if a user pauses for several hours, their Redis key survives and the flush job has persisted their progress multiple times before TTL could expire.

### What happens if the user resumes before a flush

If the user closes and reopens the video before the flush job has run:
- Redis still has the latest `maxWatchedSeconds`
- A `GET /watch/resume` endpoint (outside the scope of this assignment but the natural next addition) must read Redis first and fall back to DB
- This is the standard cache-aside pattern: Redis = hot layer, DB = persistent layer

### Flush job — in-process vs CronJob

The flush job currently runs as a `setInterval` inside the service process. This works for a single instance but has two problems at scale:

1. If running 10 service pods, you have 10 flush jobs scanning the same Redis keys simultaneously — duplicate DB writes and unpredictable key deletion.
2. If the service process crashes, the flush job dies with it.

In production, the flush job must be a **Kubernetes CronJob** — an independently scheduled pod that runs every 5 minutes, performs the flush, and exits. This decouples the flush lifecycle from the service lifecycle and ensures exactly one flush runs per cycle regardless of service replica count.

---

## 5. Key Design Decisions

### Kafka for side effects — why not Promise.all fire-and-forget

`Promise.all` fire-and-forget is in-process. If the push provider is down, the event is silently lost. Kafka gives durability — if a consumer is down, messages queue up and are processed when it recovers. At a growing media platform with paying subscribers, losing a purchase confirmation email because the email service had a 2-minute outage is unacceptable.

Each consumer has a single responsibility. Adding a new downstream integration (loyalty points, referral tracking, fraud detection) is a new consumer file — the handler and service are untouched. This is the open/closed principle applied to distributed systems.

### Redis as the hot write layer for watch progress

At 1M users, writing every heartbeat directly to the DB is infeasible. Redis absorbs the high-frequency writes; the DB only receives the collapsed final state periodically via the flush job. This reduces DB write pressure by 10x while keeping the resume feature accurate to within one flush interval (5 minutes).

### Partition by userId on watch.heartbeat

Ordering per user is guaranteed. All heartbeats for a given user land on the same Kafka partition and are processed sequentially by the same consumer instance. This makes the SETMAX operation predictable and eliminates the need for complex deduplication logic in the consumer.

### Idempotency on purchase via Redis SETNX

The atomic SETNX operation with a 24-hour TTL is the industry-standard approach for payment idempotency. It works correctly across multiple service instances when backed by real Redis. The 24-hour window matches standard payment gateway conventions.

### Layered architecture

Handlers are thin — parse, validate, delegate, respond. Services own business logic. Repositories own DB access. Events own publishing. Each layer is independently testable and replaceable. The Kafka and Redis clients are injected from config files — swapping from mock to real infrastructure is a one-file change each.

---

## 6. Trade-offs Consciously Made

**In-process Kafka and Redis mocks.** No real broker or cache required to run. The interfaces are production-identical — swapping to real infrastructure is changing `config/kafka.js` and `config/redis.js`. Nothing else changes.

**Flush job runs in-process via setInterval.** Must become a Kubernetes CronJob before horizontal scaling. Documented above and in remaining gaps.

**No retry logic on consumers.** Failed consumer messages are logged but not retried. Production requires exponential backoff retry and a dead-letter topic for permanently failed messages. Deferred because it adds significant complexity and is not essential for a first-pass refactor.

**`contentDuration` trusted from client for completion detection.** In production this should be fetched from a content metadata service with Redis caching rather than trusting client-provided values.

**Composite fallback idempotency key on purchase.** `userId:planId` as a fallback is a heuristic — it incorrectly deduplicates if a user legitimately re-purchases the same plan after cancellation. Clients must send an explicit `Idempotency-Key` header.

**Accept up to 30s of watch progress loss on abrupt close.** The `sendBeacon` mitigation reduces but does not eliminate this window. Accepted because the cost of solving it completely (client-side local storage + server reconciliation) is disproportionate to the user impact for a streaming platform.

---

## 7. Remaining Gaps

**Consumer dead-letter handling.** Failed consumer messages are logged and dropped. Production requires: retry with exponential backoff, dead-letter topic for messages that exhaust retries, and alerting when the DLT is non-empty. The revenue consumer especially — a failed revenue capture must never go silently unnoticed.

**Flush job failure handling.** If the DB upsert fails after `getdel` has already removed the Redis key, progress is silently lost. The flush job should restore the Redis key on DB failure and alert. Currently documented in the code but not implemented in the mock.

**Flush job must become a Kubernetes CronJob.** Running multiple service instances with an in-process flush job causes concurrent flushes against the same Redis keyspace. A CronJob ensures exactly one flush per cycle regardless of service replica count.

**Distributed idempotency requires real Redis.** The in-memory Redis mock is per-process. Two service instances will not share idempotency state — a purchase replayed against a different pod will not be deduplicated. Real Redis is a hard requirement before horizontal scaling.

**No resume endpoint.** The write path (this assignment) stores `maxWatchedSeconds` in Redis (primary) and DB (via flush job). The read path — `GET /watch/resume` — is the natural next addition. It must read Redis first, fall back to DB, and re-warm Redis on a DB hit. Without this endpoint, the watch pipeline has no consumer of the data it produces.

**No observability.** Missing: Prometheus metrics (request latency P50/P95/P99, Kafka consumer lag, Redis hit rate, flush job duration and record count), distributed tracing (OpenTelemetry with requestId propagation across service and consumer boundaries), alerting. Key signals: watch consumer lag, flush job error rate, Redis memory usage.

**No rate limiting.** A client sending heartbeats every second instead of every 30 generates 30x expected Kafka volume per user. A per-userId token bucket rate limiter belongs at the API gateway layer.

**Kafka topic configuration.** Production topics need explicit partition counts and replication factors defined before deployment. For `watch.heartbeat` at 1M users: 100 partitions, replication factor 3, retention 24h (heartbeats are transient). Partition count is the ceiling on consumer parallelism and should be provisioned ahead of expected peak — Kafka partitions cannot be reduced after creation.

**Authentication and authorization.** Assumed to be handled at the API gateway. In production, every endpoint needs JWT validation and the watch endpoint should verify the requesting user matches the `userId` in the payload.