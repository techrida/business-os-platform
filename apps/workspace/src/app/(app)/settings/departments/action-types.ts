// What the Departments Server Actions hand back. A plain module because a 'use server' file may
// export only async functions, and the client dialogs need these types.
import type { AccessPreviewResponse, AccessWarning } from '@bos/contracts';

export type DepartmentRecordResult =
  | { ok: true; id: string; name: string }
  | {
      ok: false;
      kind: 'stale' | 'invalid' | 'notFound' | 'error';
      message: string;
      fieldErrors?: Record<string, string>;
    };

/** The review dialog's `runPreview` answer. */
export type PeoplePreviewResult =
  { ok: true; preview: AccessPreviewResponse } | { ok: false; message: string };

/** The review dialog's `runSave` answer. */
export type PeopleSaveResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'stale' | 'confirmation' | 'invalid' | 'error';
      message: string;
      warnings?: AccessWarning[];
      fieldErrors?: Record<string, string>;
    };

export type RevisionResult = { ok: true; revision: string } | { ok: false; message: string };
