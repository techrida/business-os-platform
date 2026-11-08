import { z } from 'zod';

export const VitalNameSchema = z.enum(['LCP', 'CLS', 'INP', 'FCP', 'TTFB']);
export type VitalName = z.infer<typeof VitalNameSchema>;

/**
 * One web-vitals sample. Body of `POST /telemetry/vitals` (workspace) and
 * `POST /v1/telemetry/vitals` (API). `value` is in the metric's own unit
 * (milliseconds for LCP, INP, FCP and TTFB; unitless for CLS).
 */
export const VitalsSchema = z.object({
  name: VitalNameSchema,
  value: z.number().finite().nonnegative(),
  /** Page route template or pathname; the API maps unknown routes to `other`. */
  route: z.string().min(1).max(200),
  /** Metric id from the browser (`metric.id`). */
  id: z.string().min(1).max(100),
});
export type Vitals = z.infer<typeof VitalsSchema>;
