'use client';

import type { VitalName, Vitals } from '@bos/contracts';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useReportWebVitals } from 'next/web-vitals';

// Only the five metrics the API accepts. `next/web-vitals` also reports Next.js-specific
// metrics (hydration, route change), which the API would reject.
const SENT: ReadonlySet<string> = new Set<VitalName>(['TTFB', 'FCP', 'LCP', 'CLS', 'INP']);

// The callback must keep the same identity on every render, because useReportWebVitals
// registers it with the browser observers and a new function would register it again and
// double-count. A module-level callback cannot close over `usePathname()`, so the component
// copies the current route into this variable and the callback reads it when a metric fires.
let currentRoute = '/';

function send(sample: Vitals): void {
  const body = JSON.stringify(sample);
  // sendBeacon survives the page being closed, which is when LCP, CLS and INP are finalised.
  // It returns false when the browser refuses to queue the request.
  if (
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon('/telemetry/vitals', new Blob([body], { type: 'application/json' }))
  ) {
    return;
  }
  void fetch('/telemetry/vitals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    // Telemetry is best effort: never surface a failure to the user.
  });
}

function report(metric: { name: string; value: number; id: string }): void {
  if (!SENT.has(metric.name)) return;
  send({
    name: metric.name as VitalName,
    value: metric.value,
    route: currentRoute.slice(0, 200),
    id: metric.id,
  });
}

export function WebVitals(): null {
  const pathname = usePathname();
  useEffect(() => {
    currentRoute = pathname;
  }, [pathname]);
  useReportWebVitals(report);
  return null;
}
