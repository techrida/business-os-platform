import 'server-only';

import {
  type AdminPaymentTerm,
  AdminPaymentTermSchema,
  type AdminTaxCode,
  AdminTaxCodeSchema,
  type ChangeTaxCodeBody,
  type CreatePaymentTermBody,
  type CreateTaxCodeBody,
  type RetireTaxCodeBody,
  type UpdatePaymentTermBody,
} from '@bos/contracts';
import { z } from 'zod';

import { call, seg } from './api-procurement';
import type { Session } from './session';

// Tax codes and payment terms as Settings edits them (F1-Q49): settings.finance.write or admin.settings.write. Every
// call carries the staff session and every answer is parsed with the contracts' schemas.

const json = (method: 'POST' | 'PATCH', body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Every tax code with every period, retired and scheduled ones included. */
export function listAdminTaxCodes(session: Session): Promise<AdminTaxCode[]> {
  return call(session, '/v1/admin/tax-codes', z.array(AdminTaxCodeSchema));
}

export function createTaxCode(session: Session, body: CreateTaxCodeBody): Promise<AdminTaxCode> {
  return call(session, '/v1/admin/tax-codes', AdminTaxCodeSchema, json('POST', body));
}

/** A new period from `effectiveFrom`; the current one is closed that day. */
export function changeTaxCode(
  session: Session,
  code: string,
  body: ChangeTaxCodeBody,
): Promise<AdminTaxCode> {
  return call(
    session,
    `/v1/admin/tax-codes/${seg(code)}/changes`,
    AdminTaxCodeSchema,
    json('POST', body),
  );
}

export function retireTaxCode(
  session: Session,
  code: string,
  body: RetireTaxCodeBody,
): Promise<AdminTaxCode> {
  return call(
    session,
    `/v1/admin/tax-codes/${seg(code)}/retire`,
    AdminTaxCodeSchema,
    json('POST', body),
  );
}

/** Every payment term, retired ones included. */
export function listAdminPaymentTerms(session: Session): Promise<AdminPaymentTerm[]> {
  return call(session, '/v1/admin/payment-terms', z.array(AdminPaymentTermSchema));
}

export function createPaymentTerm(
  session: Session,
  body: CreatePaymentTermBody,
): Promise<AdminPaymentTerm> {
  return call(session, '/v1/admin/payment-terms', AdminPaymentTermSchema, json('POST', body));
}

export function updatePaymentTerm(
  session: Session,
  id: string,
  body: UpdatePaymentTermBody,
): Promise<AdminPaymentTerm> {
  return call(
    session,
    `/v1/admin/payment-terms/${seg(id)}`,
    AdminPaymentTermSchema,
    json('PATCH', body),
  );
}
