/** The one BullMQ queue P0 needs. Business queues arrive with their modules in P1. */
export const SYSTEM_QUEUE = 'system';
export const HEARTBEAT_JOB = 'system.heartbeat';
export const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * The worker reports unhealthy when no heartbeat was processed for this long (4 intervals).
 * It catches a worker that is alive as a process but cut off from Valkey.
 */
export const HEARTBEAT_STALE_AFTER_MS = 4 * HEARTBEAT_INTERVAL_MS;
