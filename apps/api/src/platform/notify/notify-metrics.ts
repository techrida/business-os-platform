// Prometheus counters for the notify worker. Serves the Reliability NFR (Non-Functional Requirement: a
// measurable quality target): an email that ran out of retries must be visible on a dashboard and alertable,
// not only in a log line somebody has to grep for.
import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';

import { MetricsService } from '../obs/metrics.service';

/** What the drainer needs from the metrics; a unit test passes an object with just this method. */
export interface DeadLetterMetric {
  recordDeadLetter(): void;
}

/**
 * Registers on MetricsService's private registry (not prom-client's global one), so two Nest apps in one
 * process (tests do this) never collide on the metric name.
 */
@Injectable()
export class NotifyMetrics implements DeadLetterMetric {
  private readonly deadLetters: Counter;

  constructor(metrics: MetricsService) {
    this.deadLetters = new Counter({
      name: 'outbox_dead_letters_total',
      help: 'Outbox emails that failed every retry and were marked dead.',
      registers: [metrics.registry],
    });
  }

  recordDeadLetter(): void {
    this.deadLetters.inc();
  }
}
