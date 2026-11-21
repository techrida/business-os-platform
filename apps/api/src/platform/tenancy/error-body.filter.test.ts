import 'reflect-metadata';

import { ErrorBodySchema } from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  type ArgumentsHost,
} from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { LedgerError } from '../../modules/ledger/ledger.service';
import { StepUpRequiredException } from '../auth/step-up';
import { ErrorBodyFilter, codeForStatus } from './error-body.filter';
import { runWithRequestStore } from './request-context';

interface Captured {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

/** Runs the filter against fake Express objects and returns what it would have sent. */
function filter(
  exception: unknown,
  reqInit: { headers?: Record<string, string>; correlationId?: string } = {},
): Captured {
  const out: Captured = { headers: {} };
  const req = {
    method: 'GET',
    path: '/v1/thing',
    headers: reqInit.headers ?? {},
    correlationId: reqInit.correlationId,
  };
  const res = {
    headersSent: false,
    setHeader: (n: string, v: string) => {
      out.headers[n] = v;
    },
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new ErrorBodyFilter().catch(exception, host);
  return out;
}

describe('ErrorBodyFilter', () => {
  it('preserves the bill invoice scan refusal only on a conflict', () => {
    const code = 'BILL_DOCUMENT_NOT_CLEAN';
    const conflict = ErrorBodySchema.parse(
      filter(new ConflictException({ code, message: 'The invoice scan is not clean.' })).body,
    );
    expect(conflict.error.code).toBe(code);
    expect(conflict.error.message).toBe('The invoice scan is not clean.');
    const wrongStatus = ErrorBodySchema.parse(
      filter(new UnprocessableEntityException({ code, message: 'private' })).body,
    );
    expect(wrongStatus.error.code).not.toBe(code);
  });
  let errorLog: MockInstance<Logger['error']>;
  beforeEach(() => {
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [new UnauthorizedException('no token'), 401, 'unauthenticated'],
    [new ForbiddenException('nope'), 403, 'forbidden'],
    [new NotFoundException('missing'), 404, 'not_found'],
    [new ConflictException('stale'), 409, 'conflict'],
    [new UnsupportedMediaTypeException('type'), 415, 'unsupported_media_type'],
    [new PayloadTooLargeException('big'), 413, 'payload_too_large'],
    [new BadRequestException('bad'), 400, 'bad_request'],
    [new ServiceUnavailableException('jwks down'), 503, 'unavailable'],
    [new InternalServerErrorException('boom'), 500, 'internal'],
    [new HttpException('teapot', 418), 418, 'bad_request'],
    [new Error('plain'), 500, 'internal'],
  ])('maps %s to %i %s with a body that parses as ErrorBodySchema', (exception, status, code) => {
    const out = filter(exception, { headers: { 'x-request-id': 'req-12345678' } });

    expect(out.status).toBe(status);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.correlationId).toBe('req-12345678');
  });

  it('keeps step_up_required on a step-up 401 so the BFF can re-authenticate (K7)', () => {
    const out = filter(new StepUpRequiredException(300));

    expect(out.status).toBe(401);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe('step_up_required');
    expect(parsed.error.message).toBe('Sign in again to approve this step');
  });

  it.each([
    ['a plain 401', new UnauthorizedException('no token')],
    ['a 401 with some other code', new UnauthorizedException({ code: 'whatever', message: 'm' })],
  ])('keeps %s as unauthenticated', (_label, exception) => {
    expect(ErrorBodySchema.parse(filter(exception).body).error.code).toBe('unauthenticated');
  });

  it('does not let a non-401 claim step_up_required', () => {
    const out = filter(new ForbiddenException({ code: 'step_up_required', message: 'm' }));

    expect(ErrorBodySchema.parse(out.body).error.code).toBe('forbidden');
  });

  it('keeps credit_hold and the deal it names on a 409, and only on a 409 (F1-Q20/F1-Q26)', () => {
    const out = filter(
      new ConflictException({
        code: 'credit_hold',
        message: 'm',
        details: { opportunityId: '0d6c1f63-62a5-4e8f-9d3c-6b4a4a1f2b11' },
      }),
    );
    expect(out.status).toBe(409);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'credit_hold',
      details: { opportunityId: '0d6c1f63-62a5-4e8f-9d3c-6b4a4a1f2b11' },
    });
    const wrongStatus = filter(
      new UnprocessableEntityException({ code: 'credit_hold', message: 'm' }),
    );
    expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('bad_request');
  });

  it('keeps fx_rate_stale and its details on a 409 so the client can say which rate is old', () => {
    const out = filter(
      new ConflictException({
        code: 'fx_rate_stale',
        message: 'The USD rate of 2026-11-01 is older than 7 days',
        details: { currency: 'USD', rateDate: '2026-11-01', maxAgeDays: 7, junk: { a: 1 } },
      }),
    );
    expect(out.status).toBe(409);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'fx_rate_stale',
      message: 'The USD rate of 2026-11-01 is older than 7 days',
    });
    // An unusable detail value drops the whole bag instead of leaking a shape clients do not know.
    expect((out.body as { error: { details?: unknown } }).error.details).toBeUndefined();

    const clean = filter(
      new ConflictException({
        code: 'fx_rate_stale',
        message: 'm',
        details: { currency: 'USD', rateDate: '2026-11-01', maxAgeDays: 7 },
      }),
    );
    expect(ErrorBodySchema.parse(clean.body).error.details).toEqual({
      currency: 'USD',
      rateDate: '2026-11-01',
      maxAgeDays: 7,
    });
  });

  it.each(['duplicate_pan_vat', 'primary_contact_exists'])(
    'keeps the customer conflict code %s on a 409',
    (code) => {
      const out = filter(new ConflictException({ code, message: 'm' }));
      expect(out.status).toBe(409);
      expect(ErrorBodySchema.parse(out.body).error.code).toBe(code);
    },
  );

  describe('duplicate_found', () => {
    const CUSTOMER = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
    const CONTACT = '9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
    const candidates = [
      { kind: 'customer', id: CUSTOMER, label: 'Acme Pvt. Ltd.', matchedOn: 'name' },
      { kind: 'contact', id: CONTACT, label: 'Sita', matchedOn: 'email', customerId: CUSTOMER },
    ];

    it('puts the candidates at error.duplicates, where the workspace reads them, and still parses', () => {
      const out = filter(
        new ConflictException({
          code: 'duplicate_found',
          message: 'Possible duplicates',
          duplicates: candidates,
        }),
      );
      expect(out.status).toBe(409);
      expect(ErrorBodySchema.parse(out.body).error.code).toBe('duplicate_found');
      expect((out.body as { error: { duplicates?: unknown } }).error.duplicates).toEqual(
        candidates,
      );
    });

    it('drops a malformed candidate list instead of leaking a shape clients do not know', () => {
      const out = filter(
        new ConflictException({
          code: 'duplicate_found',
          message: 'm',
          duplicates: [{ kind: 'customer', id: 'not-a-guid', label: 'x', matchedOn: 'name', x: 1 }],
        }),
      );
      expect(ErrorBodySchema.parse(out.body).error.code).toBe('duplicate_found');
      expect((out.body as { error: { duplicates?: unknown } }).error.duplicates).toBeUndefined();
    });

    it('is never claimed by a non-409', () => {
      const out = filter(
        new BadRequestException({ code: 'duplicate_found', message: 'm', duplicates: candidates }),
      );
      const { error } = out.body as { error: { code: string; duplicates?: unknown } };
      expect(error.code).toBe('bad_request');
      expect(error.duplicates).toBeUndefined();
    });
  });

  it('does not let a 409 claim any other code, or a non-409 claim fx_rate_stale', () => {
    expect(
      ErrorBodySchema.parse(filter(new ConflictException({ code: 'whatever', message: 'm' })).body)
        .error.code,
    ).toBe('conflict');
    expect(
      ErrorBodySchema.parse(
        filter(new BadRequestException({ code: 'fx_rate_stale', message: 'm' })).body,
      ).error.code,
    ).toBe('bad_request');
  });

  it('keeps NO_ELIGIBLE_APPROVER on a 422 (quotation submit, M4), and only on a 422', () => {
    const out = filter(
      new UnprocessableEntityException({ code: 'NO_ELIGIBLE_APPROVER', message: 'No approver' }),
    );

    expect(out.status).toBe(422);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe('NO_ELIGIBLE_APPROVER');
    expect(parsed.error.message).toBe('No approver');
    expect(
      ErrorBodySchema.parse(
        filter(new UnprocessableEntityException({ code: 'whatever', message: 'm' })).body,
      ).error.code,
    ).toBe('bad_request');
    expect(
      ErrorBodySchema.parse(
        filter(new ConflictException({ code: 'NO_ELIGIBLE_APPROVER', message: 'm' })).body,
      ).error.code,
    ).toBe('conflict');
  });

  it.each(['quotation_not_sent', 'quotation_expired'])(
    'keeps %s on a 409 (quotation outcome, Q3b/PA-3), and only on a 409',
    (code) => {
      const out = filter(new ConflictException({ code, message: 'Already answered' }));

      expect(out.status).toBe(409);
      const parsed = ErrorBodySchema.parse(out.body);
      expect(parsed.error.code).toBe(code);
      expect(parsed.error.message).toBe('Already answered');
      expect(
        ErrorBodySchema.parse(filter(new UnprocessableEntityException({ code, message: 'm' })).body)
          .error.code,
      ).toBe('bad_request');
    },
  );

  it.each([
    'kyb_not_verified',
    'customer_merged',
    'idp_org_taken',
    'first_admin_owner_only',
    'account_owner_missing',
  ])('keeps %s on a 409 (portal access grant, K8), and only on a 409', (code) => {
    const out = filter(new ConflictException({ code, message: 'Cannot grant portal access' }));

    expect(out.status).toBe(409);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBe('Cannot grant portal access');
    expect(
      ErrorBodySchema.parse(filter(new UnprocessableEntityException({ code, message: 'm' })).body)
        .error.code,
    ).toBe('bad_request');
    expect(
      ErrorBodySchema.parse(filter(new ForbiddenException({ code, message: 'm' })).body).error.code,
    ).toBe('forbidden');
  });

  it('keeps quotation_pdf_not_ready on a 409 (the quotation PDF download), and only on a 409', () => {
    const code = 'quotation_pdf_not_ready';
    const out = filter(new ConflictException({ code, message: 'The PDF is not ready' }));

    expect(out.status).toBe(409);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBe('The PDF is not ready');
    expect(
      ErrorBodySchema.parse(filter(new UnprocessableEntityException({ code, message: 'm' })).body)
        .error.code,
    ).toBe('bad_request');
  });

  describe('the staff PDF download codes', () => {
    const bound: [string, number][] = [
      ['quotation_pdf_failed', 424],
      ['quotation_pdf_unavailable', 404],
      ['quotation_pdf_retry_not_needed', 409],
      ['invoice_pdf_not_ready', 409],
      ['invoice_pdf_failed', 424],
      ['invoice_pdf_unavailable', 404],
      ['invoice_pdf_scan_refused', 404],
      ['invoice_pdf_retry_not_needed', 409],
      ['purchase_order_pdf_not_ready', 409],
      ['purchase_order_pdf_failed', 424],
      ['purchase_order_pdf_unavailable', 404],
      ['purchase_order_pdf_scan_refused', 404],
      ['purchase_order_pdf_retry_not_needed', 409],
    ];

    it.each(bound)('keeps %s on its own status %i, with its message', (code, status) => {
      const out = filter(new HttpException({ code, message: 'The PDF says so' }, status));
      expect(out.status).toBe(status);
      const parsed = ErrorBodySchema.parse(out.body);
      expect(parsed.error.code).toBe(code);
      expect(parsed.error.message).toBe('The PDF says so');
    });

    it.each(bound)(
      'reads %s on any other status as the plain code of that status',
      (code, status) => {
        const other = status === 404 ? 409 : 404;
        const parsed = ErrorBodySchema.parse(
          filter(new HttpException({ code, message: 'm' }, other)).body,
        );
        expect(parsed.error.code).toBe(other === 404 ? 'not_found' : 'conflict');
      },
    );

    it('turns a given-up render (424) into its code, not bad_request', () => {
      const out = filter(new HttpException({ code: 'invoice_pdf_failed', message: 'm' }, 424));
      expect(ErrorBodySchema.parse(out.body).error.code).toBe('invoice_pdf_failed');
      expect(
        ErrorBodySchema.parse(filter(new HttpException({ message: 'm' }, 424)).body).error.code,
      ).toBe('bad_request');
    });
  });

  it('keeps document_infected and its message on a 409 (TR-Q12e)', () => {
    const message =
      'A virus was found in this file. Remove it or upload a clean copy, then try again.';
    const out = filter(new ConflictException({ code: 'document_infected', message }));
    expect(out.status).toBe(409);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'document_infected',
      message,
    });
  });

  it.each([
    'invalid_transition',
    'kyb_not_submitted',
    'kyc_expired',
    'vendor_not_editable',
    'vendor_identity_locked',
    'account_exists',
    'no_verified_bank_account',
    'callback_evidence_not_clean',
    'VENDOR_NOT_APPROVED',
    'VENDOR_NOT_IN_ENTITY',
    'FEWER_THAN_MIN_QUOTES',
    'PO_HAS_RECEIPTS',
    'PO_HAS_NO_LINES',
    // F1-Q40 a: changing the vendor of a purchase order.
    'PO_VENDOR_CHANGE_NOT_DRAFT',
    'PO_VENDOR_UNCHANGED',
    'PO_REFERENCED',
    'VENDOR_NO_VERIFIED_BANK_ACCOUNT',
    // Issuing a draft that changed since the page read it.
    'PO_CHANGED',
  ])('keeps the vendor conflict code %s on a 409, and only on a 409', (code) => {
    const out = filter(new ConflictException({ code, message: 'm' }));
    expect(out.status).toBe(409);
    expect(ErrorBodySchema.parse(out.body).error.code).toBe(code);
    const wrongStatus = filter(new UnprocessableEntityException({ code, message: 'm' }));
    expect(wrongStatus.status).toBe(422);
    expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('bad_request');
  });

  it.each([
    'evidence_policy_unmet',
    'decided_on_in_future',
    'over_receipt',
    'over_receipt_exception_unknown',
    'po_line_unknown',
    'duplicate_po_line',
    'receipt_kind_mismatch',
    'serials_required',
    'serials_not_allowed',
    'serial_duplicate',
    'PO_AMENDMENT_INVALID',
    'DUE_DATE_BEFORE_ISSUE',
  ])(
    'keeps %s on a 422 (quotation outcome Q3b/PA-3, goods receipts P4, invoice issue), and only on a 422',
    (code) => {
      const out = filter(new UnprocessableEntityException({ code, message: 'Not accepted' }));

      expect(out.status).toBe(422);
      const parsed = ErrorBodySchema.parse(out.body);
      expect(parsed.error.code).toBe(code);
      expect(parsed.error.message).toBe('Not accepted');
      const wrongStatus = filter(new ConflictException({ code, message: 'm' }));
      expect(wrongStatus.status).toBe(409);
      expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('conflict');
    },
  );

  it.each([
    'DUPLICATE_BILL',
    'BILL_NOT_MATCHED',
    'PO_NOT_BILLABLE',
    'MATCH_NOT_REQUIRED',
    'BILL_NOT_POSTED',
    'BILL_HAS_ALLOCATIONS',
    'BILL_HAS_PAYMENT_REQUEST',
    'SUBMISSION_NOT_RECEIVED',
    'SUBMISSION_FILE_NOT_CLEAN',
    'OVER_ALLOCATION',
  ])('keeps the payables conflict code %s on a 409, and only on a 409', (code) => {
    const out = filter(new ConflictException({ code, message: 'm' }));
    expect(out.status).toBe(409);
    expect(ErrorBodySchema.parse(out.body).error.code).toBe(code);
    const wrongStatus = filter(new UnprocessableEntityException({ code, message: 'm' }));
    expect(wrongStatus.status).toBe(422);
    expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('bad_request');
  });

  it.each([
    ['unprocessable', 'The submitted data cannot be processed'],
    [
      'supporting_document_unsupported',
      'A supporting document cannot be attached to a bank change request yet',
    ],
  ])(
    'keeps the portal vendor refusal %s only on a 422, with a default message',
    (code, message) => {
      const out = filter(new UnprocessableEntityException({ code }));
      expect(out.status).toBe(422);
      expect(ErrorBodySchema.parse(out.body).error).toMatchObject({ code, message });
      expect(
        ErrorBodySchema.parse(
          filter(new UnprocessableEntityException({ code, message: 'Specific refusal' })).body,
        ).error.message,
      ).toBe('Specific refusal');
      expect(
        ErrorBodySchema.parse(filter(new ConflictException({ code, message: 'm' })).body).error
          .code,
      ).toBe('conflict');
      expect(
        ErrorBodySchema.parse(filter(new BadRequestException({ code, message: 'm' })).body).error
          .code,
      ).toBe('bad_request');
    },
  );

  it.each([
    'BILL_KIND_NOT_SUPPORTED',
    'CURRENCY_NOT_SUPPORTED',
    'CURRENCY_NOT_ENABLED',
    'SUBMISSION_HAS_NO_VENDOR',
    'SUBMISSION_INCOMPLETE',
    'SUBMISSION_MISMATCH',
    'DOCUMENT_NOT_FOUND',
    'PO_REQUIRED',
    'PO_LINE_REQUIRED',
    'PO_LINE_NOT_FOUND',
    'RECEIPT_LINE_NOT_FOUND',
    'PO_VENDOR_MISMATCH',
    'TAX_CODE_NOT_FOUND',
    'WITHHOLDING_CODE_NOT_FOUND',
    'ADVANCE_NOT_SUPPORTED',
    'DUPLICATE_OPEN_ITEM',
    'NOT_A_VENDOR_BILL_ITEM',
    'BILL_NOT_PAYABLE',
    'CURRENCY_MISMATCH',
    'PURCHASE_ORDER_NOT_FOUND',
    'BANK_ACCOUNT_INVALID',
    'BANK_ACCOUNT_CURRENCY_MISMATCH',
    'EXPENSE_ACCOUNT_INVALID',
  ])('keeps the payables refusal code %s on a 422, and only on a 422', (code) => {
    const out = filter(new UnprocessableEntityException({ code, message: 'Not accepted' }));
    expect(out.status).toBe(422);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBe('Not accepted');
    const wrongStatus = filter(new ConflictException({ code, message: 'm' }));
    expect(wrongStatus.status).toBe(409);
    expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('conflict');
  });

  it('exposes the message of a client error', () => {
    const out = filter(new ForbiddenException('Organization is not registered'));

    expect(ErrorBodySchema.parse(out.body).error.message).toBe('Organization is not registered');
  });

  it('passes a known reason through on a 403 and keeps the code and message', () => {
    const out = filter(
      new ForbiddenException({
        code: 'forbidden',
        reason: 'separation_of_duties',
        message: 'You prepared this',
      }),
    );

    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'forbidden',
      message: 'You prepared this',
      reason: 'separation_of_duties',
    });
  });

  it('passes entity_changed through on a 409 conflict (customer terms), and other reasons not', () => {
    const message = 'You switched legal entity since this page loaded; reload and try again';
    const out = filter(
      new ConflictException({ code: 'conflict', reason: 'entity_changed', message }),
    );
    expect(out.status).toBe(409);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'conflict',
      reason: 'entity_changed',
      message,
    });
    const other = filter(
      new ConflictException({ code: 'conflict', reason: 'out_of_scope', message }),
    );
    expect(ErrorBodySchema.parse(other.body).error.reason).toBeUndefined();
  });

  it('logs every 403 as one structured line with its reason, the route pattern and no user data', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      filter(
        new ForbiddenException({
          code: 'forbidden',
          reason: 'out_of_scope',
          message: 'You have no approval assignment',
        }),
        { correlationId: 'corr-403' },
      );
      filter(new NotFoundException('missing'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toEqual({
        msg: 'request forbidden',
        event: 'http.forbidden',
        status: 403,
        method: 'GET',
        // The fake request has a path but no matched route: the path never reaches the line.
        route: 'unmatched',
        code: 'forbidden',
        reason: 'out_of_scope',
        correlationId: 'corr-403',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('names a refused first-step approver with its 422 code', () => {
    const out = filter(
      new UnprocessableEntityException({
        code: 'APPROVER_NOT_ELIGIBLE',
        message: 'The chosen approver cannot approve this quotation.',
      }),
    );
    expect(out.status).toBe(422);
    expect(ErrorBodySchema.parse(out.body).error.code).toBe('APPROVER_NOT_ELIGIBLE');
  });

  it('passes a known reason through on a 400: a malformed X-Entity-Id is invalid_entity', () => {
    const out = filter(
      new BadRequestException({
        code: 'bad_request',
        message: 'X-Entity-Id must be a uuid',
        reason: 'invalid_entity',
      }),
    );

    expect(out.status).toBe(400);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'bad_request',
      message: 'X-Entity-Id must be a uuid',
      reason: 'invalid_entity',
    });
  });

  it('passes deadline_in_past through on a 400: an RFQ whose quotation deadline has passed (I-28)', () => {
    const out = filter(
      new BadRequestException({
        code: 'bad_request',
        reason: 'deadline_in_past',
        message: 'The quotation deadline has passed. Choose a date and time in the future.',
      }),
    );
    expect(out.status).toBe(400);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'bad_request',
      reason: 'deadline_in_past',
      message: 'The quotation deadline has passed. Choose a date and time in the future.',
    });
  });

  it('drops an unknown reason, a reason on a plain 403, and a reason on any other status', () => {
    const unknown = filter(new ForbiddenException({ reason: 'because I said so' }));
    expect(ErrorBodySchema.parse(unknown.body).error).not.toHaveProperty('reason');
    expect(ErrorBodySchema.parse(unknown.body).error.message).toBe('Forbidden');

    const plain = filter(new ForbiddenException('nope'));
    expect(ErrorBodySchema.parse(plain.body).error).not.toHaveProperty('reason');

    const conflict = filter(new ConflictException({ reason: 'out_of_scope', message: 'stale' }));
    expect(ErrorBodySchema.parse(conflict.body).error).not.toHaveProperty('reason');
  });

  it('joins a validation message array', () => {
    const out = filter(new BadRequestException(['a is required', 'b must be a number']));

    expect(ErrorBodySchema.parse(out.body).error.message).toBe('a is required; b must be a number');
  });

  it('hides the detail of a 5xx and logs it with the correlation id and stack', () => {
    const secret = new Error('connection to postgres://bos_app:hunter2@db failed');
    const out = filter(secret, { correlationId: 'corr-abcdef12' });

    const serialized = JSON.stringify(out.body);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('postgres');
    expect(serialized).not.toContain('at '); // no stack frames
    expect(ErrorBodySchema.parse(out.body).error.message).toBe('Internal server error');

    expect(errorLog).toHaveBeenCalledOnce();
    const [message, stack] = errorLog.mock.calls[0] as [string, string];
    expect(message).toContain('corr-abcdef12');
    expect(message).toContain('500');
    expect(stack).toContain('hunter2'); // the log keeps the detail, the response does not
  });

  it('hides the message of an explicit 500 HttpException too', () => {
    const out = filter(new InternalServerErrorException('internal detail'));

    expect(JSON.stringify(out.body)).not.toContain('internal detail');
  });

  it('keeps the 503 message (it is written by us) and logs it', () => {
    const out = filter(new ServiceUnavailableException('Identity provider unavailable'));

    expect(ErrorBodySchema.parse(out.body).error.message).toBe('Identity provider unavailable');
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it('does not log 4xx errors as errors', () => {
    filter(new UnauthorizedException());

    expect(errorLog).not.toHaveBeenCalled();
  });

  it('maps a plain Express error that carries a status (body-parser 413)', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413 });
    const out = filter(tooLarge);

    expect(out.status).toBe(413);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code: 'payload_too_large',
      message: 'Payload too large',
    });
  });

  it('takes the correlation id from the request context first', () => {
    const out = runWithRequestStore('ctx-12345678', () =>
      filter(new UnauthorizedException(), { headers: { 'x-request-id': 'header-12345678' } }),
    );

    expect(ErrorBodySchema.parse(out.body).error.correlationId).toBe('ctx-12345678');
    expect(out.headers['x-request-id']).toBe('ctx-12345678');
  });

  it('falls back to a valid x-request-id header, else generates one, outside the context', () => {
    const fromHeader = filter(new UnauthorizedException(), {
      headers: { 'x-request-id': 'header-12345678' },
    });
    expect(ErrorBodySchema.parse(fromHeader.body).error.correlationId).toBe('header-12345678');

    const generated = filter(new UnauthorizedException(), {
      headers: { 'x-request-id': 'bad id' },
    });
    const id = ErrorBodySchema.parse(generated.body).error.correlationId;
    expect(id).not.toBe('bad id');
    expect(id.length).toBeGreaterThanOrEqual(8);
  });

  it('codeForStatus covers the documented table', () => {
    expect([401, 403, 404, 409, 413, 415, 400, 503, 500, 502].map(codeForStatus)).toEqual([
      'unauthenticated',
      'forbidden',
      'not_found',
      'conflict',
      'payload_too_large',
      'unsupported_media_type',
      'bad_request',
      'unavailable',
      'internal',
      'internal',
    ]);
  });

  it('passes the dates of a refused invoice issue through as details (DUE_DATE_BEFORE_ISSUE)', () => {
    const out = filter(
      new UnprocessableEntityException({
        code: 'DUE_DATE_BEFORE_ISSUE',
        message: 'The due date is before the issue date',
        details: { dueDate: '2026-11-09', issueDate: '2026-11-12' },
      }),
    );
    expect(ErrorBodySchema.parse(out.body).error.details).toEqual({
      dueDate: '2026-11-09',
      issueDate: '2026-11-12',
    });
  });

  it.each([
    'quotation_not_accepted',
    'sales_order_not_open',
    'delivery_already_released',
    'schedule_line_not_planned',
    'SCHEDULE_LINE_TAKEN',
    'NOT_APPROVED',
    'payment_not_submitted',
    'payment_not_verified',
    'proof_not_clean',
    'CREDIT_EXCEEDS_INVOICE',
  ])('keeps the P3 conflict code %s on a 409, and only on a 409', (code) => {
    const out = filter(new ConflictException({ code, message: 'Not now' }));

    expect(out.status).toBe(409);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBe('Not now');
    const wrongStatus = filter(new UnprocessableEntityException({ code, message: 'm' }));
    expect(wrongStatus.status).toBe(422);
    expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('bad_request');
  });

  it.each(['promise_open', 'invoice_not_open'])(
    'keeps the promise to pay conflict code %s and its message on a 409, and only on a 409',
    (code) => {
      const out = filter(new ConflictException({ code, message: 'Try again in a few minutes.' }));

      expect(out.status).toBe(409);
      const parsed = ErrorBodySchema.parse(out.body);
      expect(parsed.error.code).toBe(code);
      expect(parsed.error.message).toBe('Try again in a few minutes.');
      const wrongStatus = filter(new UnprocessableEntityException({ code, message: 'm' }));
      expect(wrongStatus.status).toBe(422);
      expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('bad_request');
    },
  );

  it.each([
    'invalid_proof',
    'unknown_customer',
    'unknown_withholding_code',
    'reason_required',
    'invalid_evidence_document',
    'invalid_payment_schedule',
    'evidence_required',
  ])('keeps the P3 validation code %s on a 422, and only on a 422', (code) => {
    const out = filter(new UnprocessableEntityException({ code, message: 'Cannot do that' }));

    expect(out.status).toBe(422);
    const parsed = ErrorBodySchema.parse(out.body);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBe('Cannot do that');
    const wrongStatus = filter(new ConflictException({ code, message: 'm' }));
    expect(wrongStatus.status).toBe(409);
    expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('conflict');
  });
});

describe('ledger errors on the HTTP boundary', () => {
  it.each([
    ['OVER_ALLOCATION', 409],
    ['MISMATCHED_ITEMS', 422],
  ] as const)('preserves %s only at its domain status', (code, status) => {
    const out = filter(new LedgerError(code, 'Allocation refused', { amount: '1000.01' }));
    expect(out.status).toBe(status);
    expect(ErrorBodySchema.parse(out.body).error).toMatchObject({
      code,
      message: 'Allocation refused',
      details: { amount: '1000.01' },
    });
    const wrongStatus = status === 409 ? 422 : 409;
    const wrong = filter(new HttpException({ code, message: 'Refused' }, wrongStatus));
    expect(ErrorBodySchema.parse(wrong.body).error.code).toBe(codeForStatus(wrongStatus));
  });
});

describe('access settings errors on the HTTP boundary', () => {
  it.each(['stale_access', 'confirmation_required', 'last_founder', 'members_changed'])(
    'keeps %s on a 409, and only on a 409',
    (code) => {
      const out = filter(new ConflictException({ code, message: 'Refused' }));
      expect(out.status).toBe(409);
      expect(ErrorBodySchema.parse(out.body).error.code).toBe(code);
      const wrongStatus = filter(new UnprocessableEntityException({ code, message: 'm' }));
      expect(wrongStatus.status).toBe(422);
      expect(ErrorBodySchema.parse(wrongStatus.body).error.code).toBe('bad_request');
    },
  );

  it('passes validated warnings through on 409 confirmation_required and drops malformed ones', () => {
    const warnings = [
      {
        code: 'W3',
        severity: 'confirm',
        message: 'Two people hold roles that allow both entering and approving bills.',
        people: 2,
      },
    ];
    const out = filter(
      new ConflictException({
        code: 'confirmation_required',
        message: 'Confirm before saving.',
        warnings,
      }),
    );
    expect(out.status).toBe(409);
    expect(ErrorBodySchema.parse(out.body).error.code).toBe('confirmation_required');
    expect((out.body as { error: { warnings?: unknown } }).error.warnings).toEqual(warnings);

    const malformed = filter(
      new ConflictException({
        code: 'confirmation_required',
        message: 'Confirm before saving.',
        warnings: [{ code: 'W99', severity: 'confirm', message: 'bad' }],
      }),
    );
    expect((malformed.body as { error: { warnings?: unknown } }).error.warnings).toBeUndefined();
  });

  it('passes validated fieldErrors and warnings through on 422 unprocessable', () => {
    const out = filter(
      new UnprocessableEntityException({
        code: 'unprocessable',
        message: 'Access change blocked.',
        fieldErrors: { 'changes.0.role': 'Founder permissions cannot be changed.' },
        warnings: [
          {
            code: 'W1',
            severity: 'blocked',
            message: 'Founder permissions cannot be changed.',
            changeIndex: 0,
          },
        ],
      }),
    );
    expect(out.status).toBe(422);
    expect(ErrorBodySchema.parse(out.body).error.code).toBe('unprocessable');
    const err = (
      out.body as {
        error: { fieldErrors?: unknown; warnings?: unknown };
      }
    ).error;
    expect(err.fieldErrors).toEqual({
      'changes.0.role': 'Founder permissions cannot be changed.',
    });
    expect(err.warnings).toEqual([
      {
        code: 'W1',
        severity: 'blocked',
        message: 'Founder permissions cannot be changed.',
        changeIndex: 0,
      },
    ]);
  });
});

describe('database busy errors on the HTTP boundary', () => {
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['40P01', 'deadlock detected', '1'],
    ['55P03', 'canceling statement due to lock timeout', '2'],
  ])(
    'answers %s as a retryable 503 db_busy with Retry-After %s, also when drizzle wraps it',
    (code, message, retryAfter) => {
      const raw = pgError(code, message);
      for (const exception of [raw, new DrizzleQueryError('update app.x set y = $1', [1], raw)]) {
        const out = filter(exception);
        expect(out.status).toBe(503);
        expect(out.headers['Retry-After']).toBe(retryAfter);
        const parsed = ErrorBodySchema.parse(out.body);
        expect(parsed.error.code).toBe('db_busy');
        expect(parsed.error.message).toBe('Busy, please try again');
        expect(parsed.error.details).toEqual({ retryAfterSeconds: Number(retryAfter) });
        expect(JSON.stringify(out.body)).not.toContain('app.x');
      }
    },
  );

  it('logs a warning without the stack, not an error', () => {
    const warn = vi.mocked(Logger.prototype.warn);
    const error = vi.mocked(Logger.prototype.error);
    filter(pgError('40P01', 'deadlock detected'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('deadlock');
    expect(error).not.toHaveBeenCalled();
  });

  it('leaves other database errors a plain 500 without Retry-After', () => {
    for (const exception of [
      pgError('23505', 'duplicate key'),
      pgError('25P03', 'terminating connection due to idle-in-transaction timeout'),
      new DrizzleQueryError('select 1', [], pgError('57014', 'canceling statement')),
    ]) {
      const out = filter(exception);
      expect(out.status).toBe(500);
      expect(out.headers['Retry-After']).toBeUndefined();
      expect(ErrorBodySchema.parse(out.body).error.code).toBe('internal');
    }
  });

  it('does not let an HttpException carrying a busy code through as db_busy', () => {
    const out = filter(new ConflictException({ code: '40P01', message: 'x' }));
    expect(out.status).toBe(409);
    expect(ErrorBodySchema.parse(out.body).error.code).toBe('conflict');
  });
});
