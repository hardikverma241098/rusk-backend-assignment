# Streaming Platform Backend

Refactored Node.js/Express service with event-driven architecture.

## Setup

```bash
npm install
npm start
```

Server runs on port 3000 (override with `PORT` env variable).

## Architecture

```
Handler → Service → Repository (DB)
                 → Kafka Producer → topic

Consumers (async):
  notification-service    ← user.signed_up, purchase.completed
  analytics-service       ← user.signed_up, purchase.completed, watch.heartbeat
  crm-service             ← user.signed_up, purchase.completed
  revenue-service         ← purchase.completed
  watch-progress-writer   ← watch.heartbeat → Redis SETMAX

Flush job (every 5 mins):
  Redis SCAN → bulk upsert → DB
```

Kafka is mocked in-process via `config/kafka.js`. Swap that file for a real `kafkajs` client to connect to a broker — nothing else changes.

Redis is mocked in-process via `config/redis.js`. Swap for `ioredis` in the same way.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `WATCH_FLUSH_INTERVAL_MS` | `300000` | Watch flush job interval (ms) |
| `LOG_LEVEL` | `info` | Pino log level |

## Endpoints

### POST /user/signup
```json
{ "userId": "u1", "email": "user@example.com", "name": "Hardik", "deviceToken": "optional" }
```

### POST /purchase/complete
```json
{ "userId": "u1", "planId": "premium", "amount": 499, "email": "user@example.com", "deviceToken": "optional" }
```
Send `Idempotency-Key` header to prevent duplicate purchases.

### POST /watch/event
```json
{ "userId": "u1", "contentId": "v1", "watchedSeconds": 120, "sessionId": "s1" }
```
Publishes directly to Kafka, partitioned by `userId`. Watch progress written to Redis via consumer, flushed to DB every 5 minutes.

## Design

See [DESIGN.md](./DESIGN.md).
