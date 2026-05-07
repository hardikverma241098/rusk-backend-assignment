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
  notification-service  ← user.signed_up, purchase.completed
  analytics-service     ← user.signed_up, purchase.completed, watch.heartbeat.batch
  crm-service           ← user.signed_up, purchase.completed
  revenue-service       ← purchase.completed
  watch-db-writer       ← watch.heartbeat.batch
```

Kafka is mocked in-process via `config/kafka.js`. Swap that file for a real `kafkajs` client to connect to a broker — nothing else changes.

Redis is mocked in-process via `config/redis.js`. Swap for `ioredis` in the same way.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `WATCH_BUFFER_MAX_SIZE` | `100` | Max events before forced flush |
| `WATCH_FLUSH_INTERVAL_MS` | `5000` | Watch buffer flush interval |
| `LOG_LEVEL` | `info` | Pino log level |

## Endpoints

### POST /user/signup
```json
{ "userId": "u1", "email": "user@example.com", "name": "Hardik", "deviceToken": "optional" }
```

### POST /purchase/complete
```json
{ "userId": "u1", "planId": "premium", "amount": 499, "email": "user@example.com" }
```
Send `Idempotency-Key` header to prevent duplicate purchases.

### POST /watch/event
```json
{ "userId": "u1", "contentId": "v1", "watchedSeconds": 120, "sessionId": "s1" }
```
Buffered in memory, flushed to Kafka every 5 seconds.

## Design

See [DESIGN.md](./DESIGN.md).
