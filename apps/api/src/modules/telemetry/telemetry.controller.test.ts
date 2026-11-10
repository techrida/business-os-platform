import 'reflect-metadata';

import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MetricsService } from '../../platform/obs/metrics.service';
import {
  MAX_VITALS_BODY_BYTES,
  TelemetryController,
  VITALS_ROUTE_ALLOWLIST,
  labelForRoute,
} from './telemetry.controller';

const sample = (over: Record<string, unknown> = {}) => ({
  name: 'LCP',
  value: 1250,
  route: '/',
  id: 'v5-1234567890',
  ...over,
});

describe('TelemetryController.vitals', () => {
  const observeWebVitalLcp = vi.fn();
  let controller: TelemetryController;

  beforeEach(() => {
    observeWebVitalLcp.mockReset();
    controller = new TelemetryController({ observeWebVitalLcp } as unknown as MetricsService);
  });

  it('records LCP in seconds under the workspace app and the route', () => {
    controller.vitals('80', sample({ value: 1250, route: '/staff-only' }));

    expect(observeWebVitalLcp).toHaveBeenCalledExactlyOnceWith('workspace', '/staff-only', 1.25);
  });

  it('allows exactly "/" and "/staff-only"', () => {
    expect([...VITALS_ROUTE_ALLOWLIST].sort()).toEqual(['/', '/staff-only']);
  });

  it.each([
    ['/customers/42', 'other'],
    ['/staff-only/', 'other'],
    ['/STAFF-ONLY', 'other'],
    ['/?utm=x', 'other'],
    ['', 'other'],
    ['/', '/'],
    ['/staff-only', '/staff-only'],
  ])('labels route %j as %j', (route, label) => {
    expect(labelForRoute(route)).toBe(label);
  });

  it('records an unlisted route as "other" so clients cannot create labels', () => {
    controller.vitals(undefined, sample({ route: '/some/new/' + 'x'.repeat(100) }));

    expect(observeWebVitalLcp).toHaveBeenCalledExactlyOnceWith('workspace', 'other', 1.25);
  });

  it.each(['CLS', 'INP', 'FCP', 'TTFB'])('accepts %s but records nothing in P0', (name) => {
    expect(() => controller.vitals(undefined, sample({ name }))).not.toThrow();
    expect(observeWebVitalLcp).not.toHaveBeenCalled();
  });

  it('rejects a body whose content-length header is over 2048 with 413', () => {
    expect(() => controller.vitals(String(MAX_VITALS_BODY_BYTES + 1), sample())).toThrow(
      PayloadTooLargeException,
    );
    expect(observeWebVitalLcp).not.toHaveBeenCalled();
  });

  it('accepts a content-length of exactly 2048', () => {
    expect(() => controller.vitals(String(MAX_VITALS_BODY_BYTES), sample())).not.toThrow();
  });

  it('rejects a parsed body over 2048 bytes with 413 even when the header lies or is absent', () => {
    const padded = sample({ id: 'x'.repeat(MAX_VITALS_BODY_BYTES) });

    expect(() => controller.vitals('50', padded)).toThrow(PayloadTooLargeException);
    expect(() => controller.vitals(undefined, padded)).toThrow(PayloadTooLargeException);
    expect(observeWebVitalLcp).not.toHaveBeenCalled();
  });

  it('measures bytes, not characters', () => {
    // 700 three-byte characters are 2100 bytes but only 700 characters.
    const multibyte = sample({ id: '€'.repeat(700) });
    expect(JSON.stringify(multibyte).length).toBeLessThan(MAX_VITALS_BODY_BYTES);

    expect(() => controller.vitals(undefined, multibyte)).toThrow(PayloadTooLargeException);
  });

  it.each([
    ['unknown metric name', sample({ name: 'FID' })],
    ['negative value', sample({ value: -1 })],
    ['string value', sample({ value: '12' })],
    ['missing id', sample({ id: undefined })],
    ['empty route', sample({ route: '' })],
    ['not an object', 'LCP'],
    ['missing body', undefined],
  ])('rejects %s with 400 naming fields only', (_why, body) => {
    expect(() => controller.vitals(undefined, body)).toThrow(BadRequestException);
    expect(observeWebVitalLcp).not.toHaveBeenCalled();
  });

  it('does not echo submitted values in the 400 message', () => {
    try {
      controller.vitals(undefined, sample({ name: '<script>alert(1)</script>' }));
      expect.unreachable();
    } catch (e) {
      expect((e as BadRequestException).message).toBe('Invalid vitals sample: name');
    }
  });
});
