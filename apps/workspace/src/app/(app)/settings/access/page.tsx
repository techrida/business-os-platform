import type { AccessCatalogueResponse } from '@bos/contracts';
import type { Metadata } from 'next';

import { AreaCards } from '@/components/access/area-cards';
import type { DepartmentOption } from '@/components/access/hand-overs-editor';
import type { ReviewPerson } from '@/components/access/review-changes-dialog';
import { permissionChecker } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import {
  ACCESS_LOAD_ERROR_MESSAGE,
  getAccessCatalogue,
  listAccessPeople,
  listActiveDepartmentsForAccess,
} from '@/lib/api-access';
import type { Session } from '@/lib/session';

import { formatInstant } from '../format';
import { requireSection } from '../guard';
import { checkWithChangesAction, previewAccessAction, saveAccessAction } from './actions';
import styles from './access.module.css';

export const metadata: Metadata = { title: 'Access · Business OS' };

type Loaded = { ok: true; catalogue: AccessCatalogueResponse } | { ok: false; message: string };

async function loadCatalogue(session: Session): Promise<Loaded> {
  try {
    return { ok: true, catalogue: await getAccessCatalogue(session) };
  } catch (error) {
    // Plain words for a non-technical Founder (review R7); a refusal says what is missing.
    const message =
      error instanceof ApiError && error.status === 403
        ? "You don't have permission to view access settings."
        : ACCESS_LOAD_ERROR_MESSAGE;
    return { ok: false, message };
  }
}

async function loadDepartments(session: Session): Promise<DepartmentOption[] | null> {
  try {
    const list = await listActiveDepartmentsForAccess(session);
    return list.items.map((department) => ({ id: department.id, name: department.name }));
  } catch {
    return null;
  }
}

async function loadPeople(session: Session): Promise<ReviewPerson[]> {
  try {
    const people = await listAccessPeople(session);
    return people
      .filter((person) => person.status !== 'inactive')
      .map((person) => ({
        id: person.id,
        name: person.name,
        description: person.departmentName ?? person.email ?? undefined,
      }));
  } catch {
    return [];
  }
}

/** Access > By area (spec 4). The frame (heading and tabs) comes from layout.tsx. */
export default async function AccessByAreaPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string | string[] }>;
}) {
  const { area } = await searchParams;
  const session = await requireSection('roles');
  const canEdit = permissionChecker(session.roles)('admin.roles.write');
  const [loaded, departments, people] = await Promise.all([
    loadCatalogue(session),
    loadDepartments(session),
    canEdit ? loadPeople(session) : Promise.resolve([]),
  ]);

  if (!loaded.ok) {
    return (
      <Alert
        tone="error"
        role="alert"
        actions={
          <LinkButton href="/settings/access" variant="secondary" size="small">
            Try again
          </LinkButton>
        }
      >
        {loaded.message}
      </Alert>
    );
  }

  const { catalogue } = loaded;
  return (
    <>
      {canEdit ? null : <Alert tone="info">Only a Founder can change access.</Alert>}
      {catalogue.lastChanged ? (
        <p className={styles.lastChanged}>
          Last changed {formatInstant(catalogue.lastChanged.at)}
          {catalogue.lastChanged.byName ? ` by ${catalogue.lastChanged.byName}` : ''}
        </p>
      ) : null}
      <AreaCards
        // A new revision (after a save or a reload) starts every card from the saved values.
        key={catalogue.revision}
        catalogue={catalogue}
        canEdit={canEdit}
        initialAreaKey={typeof area === 'string' ? area : undefined}
        departments={departments}
        people={people}
        actions={{
          preview: previewAccessAction,
          save: saveAccessAction,
          check: checkWithChangesAction,
        }}
      />
    </>
  );
}
