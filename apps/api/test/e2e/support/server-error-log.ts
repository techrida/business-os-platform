import type { LoggerService } from '@nestjs/common';

/** Where the 5xx stacks go: the test run's stderr, which vitest shows next to the failing test. */
export type ServerErrorSink = (text: string) => void;

const stderrSink: ServerErrorSink = (text) => {
  process.stderr.write(`${text}\n`);
};

/** The line ErrorBodyFilter logs, with its stack, for every 5xx response other than a busy 503. */
const SERVER_ERROR_LINE = /failed with 5\d\d \(correlationId=/;
const FILTER_CONTEXT = 'ErrorBodyFilter';

/**
 * Wraps the app's logger so that the stack of every 5xx response is written out in e2e runs, whatever LOG_LEVEL says
 * (the runs use `silent`). The API returns a fixed message for a 5xx, so without this an intermittent 500 leaves a
 * failed assertion and nothing about what threw (the one seen at p3-exit step 11). Every other call passes through.
 */
export function logServerErrors(
  inner: LoggerService,
  sink: ServerErrorSink = stderrSink,
): LoggerService {
  return {
    log: (message: unknown, ...rest: unknown[]) => {
      inner.log(message, ...rest);
    },
    warn: (message: unknown, ...rest: unknown[]) => {
      inner.warn(message, ...rest);
    },
    debug: (message: unknown, ...rest: unknown[]) => {
      inner.debug?.(message, ...rest);
    },
    verbose: (message: unknown, ...rest: unknown[]) => {
      inner.verbose?.(message, ...rest);
    },
    fatal: (message: unknown, ...rest: unknown[]) => {
      inner.fatal?.(message, ...rest);
    },
    setLogLevels: (levels) => {
      inner.setLogLevels?.(levels);
    },
    error: (message: unknown, ...rest: unknown[]) => {
      if (
        typeof message === 'string' &&
        SERVER_ERROR_LINE.test(message) &&
        rest[rest.length - 1] === FILTER_CONTEXT
      ) {
        const stack = rest.find(
          (part): part is string => typeof part === 'string' && part !== FILTER_CONTEXT,
        );
        sink(`[e2e server error] ${message}${stack === undefined ? '' : `\n${stack}`}`);
      }
      inner.error(message, ...rest);
    },
  };
}
