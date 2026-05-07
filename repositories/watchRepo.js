/**
 * repositories/watchRepo.js
 *
 * batchUpsertProgress writes the latest watch position per (userId, contentId).
 *
 * Production SQL (PostgreSQL):
 *   INSERT INTO watch_progress
 *     (user_id, content_id, max_watched_seconds, session_id, device_type, updated_at)
 *   VALUES
 *     (unnest($1), unnest($2), unnest($3), unnest($4), unnest($5), unnest($6))
 *   ON CONFLICT (user_id, content_id)
 *   DO UPDATE SET
 *     max_watched_seconds = GREATEST(watch_progress.max_watched_seconds, excluded.max_watched_seconds),
 *     session_id          = excluded.session_id,
 *     device_type         = excluded.device_type,
 *     updated_at          = excluded.updated_at
 *   WHERE excluded.updated_at > watch_progress.updated_at;
 *
 * Production MongoDB:
 *   bulkWrite with updateOne + upsert:true per record, using $max operator:
 *   { $max: { maxWatchedSeconds: value }, $set: { sessionId, deviceType, updatedAt } }
 *
 * GREATEST / $max ensures out-of-order flush batches never overwrite
 * a higher progress value with a lower one.
 */
async function batchUpsertProgress(records) {
  // Simulates one DB round-trip regardless of batch size
  return new Promise((resolve) => setTimeout(resolve, 20));
}

module.exports = { batchUpsertProgress };
