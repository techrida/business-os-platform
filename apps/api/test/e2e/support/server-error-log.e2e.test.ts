import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorBodyFilter } from '../../../src/platform/tenancy/error-body.filter';
import { logServerErrors } from './server-error-log';

// The e2e runs set LOG_LEVEL=silent, so the stack ErrorBodyFilter logs for a 5xx is lost. logServerErrors, installed
// by startApp, writes it out. This drives the real filter with a thrown Error and checks the stack reaches the sink.
function hostFor(path: string): ArgumentsHost {
  const res = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const req = { method: 'POST', path, headers: {}, id: 'req-1' };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
}

describe('logServerErrors', () => {
  afterEach(() => {
    Logger.overrideLogger(false);
  });

  const silentInner = () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  it('writes the stack of a 500 even though the inner logger is silent', () => {
    const sink = vi.fn();
    const inner = silentInner();
    Logger.overrideLogger(logServerErrors(inner, sink));
    const boom = new Error('kaput in the service');

    new ErrorBodyFilter().catch(boom, hostFor('/v1/quotations'));

    expect(sink).toHaveBeenCalledOnce();
    const written = String(sink.mock.calls[0]?.[0]);
    expect(written).toContain('POST /v1/quotations failed with 500');
    expect(written).toContain('kaput in the service');
    expect(written).toContain('at '); // a stack frame
    expect(inner.error).toHaveBeenCalledOnce();
  });

  it('writes nothing for a 4xx', () => {
    const sink = vi.fn();
    Logger.overrideLogger(logServerErrors(silentInner(), sink));

    new ErrorBodyFilter().catch(new HttpException('nope', 409), hostFor('/v1/quotations'));

    expect(sink).not.toHaveBeenCalled();
  });
});
