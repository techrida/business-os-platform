// Turns a failed KYB call (open a case, attach a document, submit) into a sentence a person can act
// on. Pure (no server-only import), so the actions and their tests can use it.
//
// Why not `failureOf` alone: every refusal of the verification service is a 409 with the generic
// code `conflict`, and only the message tells them apart ("Required documents are missing: ...",
// "A case in status submitted cannot be changed", "This record was changed by someone else ...").
// The 422 for a document that is not on this case would read as "the platform did not respond".
// Only keys we know are echoed from the message, never free text.

import { CHECKLIST_ITEM_KEYS, type ChecklistItem } from '@bos/contracts';

import { describeFailure } from '@/lib/kernel-ui';
import { infectedFileMessage } from '@/lib/infected-file';

import { CHECKLIST_LABEL } from '../customers/format';
import { isIdempotencyInProgress, STILL_SAVING_MESSAGE } from '../quote-builder/failure';

export type KybContext = 'open' | 'attach' | 'submit';

export interface KybFailure {
  message: string;
  /** True when the page is out of date, so the person should reload it. */
  reload: boolean;
}

interface ErrorLike {
  status?: unknown;
  body?: unknown;
}

function errorFields(body: unknown): {
  code?: string | undefined;
  message: string;
  reason?: string | undefined;
} {
  const e = (body as { error?: Record<string, unknown> } | null | undefined)?.error;
  const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return { code: text(e?.code), message: text(e?.message) ?? '', reason: text(e?.reason) };
}

const MISSING = /^Required documents are missing: (.+)$/;

/** The labels of the checklist items named in a "Required documents are missing" message. */
export function missingLabels(message: string): string[] {
  const list = MISSING.exec(message)?.[1];
  if (list === undefined) return [];
  const known: readonly string[] = CHECKLIST_ITEM_KEYS;
  return list
    .split(',')
    .map((k) => k.trim())
    .filter((k) => known.includes(k))
    .map((k) => CHECKLIST_LABEL[k as ChecklistItem['key']]);
}

export function kybFailure(err: unknown, context: KybContext): KybFailure {
  const status = Number((err as ErrorLike | null | undefined)?.status ?? 0);
  const { code, message, reason } = errorFields((err as ErrorLike | null | undefined)?.body);

  if (status === 409) {
    if (isIdempotencyInProgress(err)) return { message: STILL_SAVING_MESSAGE, reload: false };
    const infected = infectedFileMessage(err);
    if (infected !== undefined) return { message: infected, reload: false };

    if (MISSING.test(message)) {
      const labels = missingLabels(message);
      return {
        message:
          labels.length > 0
            ? `These required documents still have no file: ${labels.join(', ')}. Attach them, then submit.`
            : 'This case needs at least one required document before it can be submitted.',
        reload: false,
      };
    }
    if (/cannot be (changed|submitted)/.test(message)) {
      return {
        message:
          context === 'submit'
            ? 'This case is no longer a draft. It may already have been submitted. Reload to see where it stands.'
            : 'This case can no longer be changed because it was submitted or decided. Reload to see where it stands.',
        reload: true,
      };
    }
    if (/changed by someone else/.test(message)) {
      return {
        message:
          'Someone else changed this case after you opened it. Reload to see the latest, then try again.',
        reload: true,
      };
    }
  }

  if (status === 422 && context === 'attach') {
    return {
      message: 'That file does not belong to this case. Choose the file again and upload it.',
      reload: false,
    };
  }

  if (status === 404 && context === 'open') {
    return {
      message: 'We could not find that customer. It may have been merged or removed.',
      reload: false,
    };
  }

  const f = describeFailure(
    {
      status,
      code,
      reason,
      detail: status === 400 && message !== '' ? message : undefined,
    },
    'generic',
  );
  return { message: f.message, reload: f.reload };
}
