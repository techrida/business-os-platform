// Names shared by the notify service (which nudges) and the outbox drainer (which consumes).
// They live in their own file so the worker side imports them without pulling in the service.
// Serves the Reliability NFR (Non-Functional Requirement: a measurable quality target): one agreed
// queue and job name, so a nudge can never be sent to a queue nobody drains.

/** The BullMQ queue that carries the outbox drain job. */
export const OUTBOX_QUEUE = 'outbox';

/** The job that sends pending outbox rows. Nudged after a commit and repeated every 5 s as the backstop. */
export const OUTBOX_DRAIN_JOB = 'outbox.drain';
