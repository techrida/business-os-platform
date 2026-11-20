import type { AuditEventDto } from '@bos/contracts';
import type { Metadata } from 'next';

import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, Td, Th } from '@/components/ui/table';
import { getPermissionCheck } from '@/lib/live-permissions';
import type { Session } from '@/lib/session';

import { formatInstant } from '../../format';
import { requireAccess } from '../roles/_lib/guard';
import { loadCatalogue, loadErrorMessage, type Loaded } from '../roles/_lib/load';
import { LoadError } from '../roles/_lib/load-error';
import {
  actorName,
  describeChange,
  HISTORY_DENIED_MESSAGE,
  HISTORY_HREF,
  labelsFrom,
  NO_LABELS,
} from './describe';
import { listAccessHistory } from './load';

export const metadata: Metadata = { title: 'Access history · Business OS' };

async function loadHistory(session: Session): Promise<Loaded<AuditEventDto[]>> {
  try {
    return { ok: true, data: await listAccessHistory(session) };
  } catch (error) {
    return { ok: false, message: loadErrorMessage(error) };
  }
}

/**
 * Access > history (spec 4, "View history"): the latest access changes, read only. Opens with the
 * Access screens' own check, then needs the live `audit.read` grant; the API refuses without it too.
 */
export default async function AccessHistoryPage() {
  const { session } = await requireAccess(HISTORY_HREF);
  const can = await getPermissionCheck(session);
  if (!can('audit.read')) return <Alert tone="info">{HISTORY_DENIED_MESSAGE}</Alert>;

  const [history, catalogue] = await Promise.all([loadHistory(session), loadCatalogue(session)]);
  if (!history.ok) return <LoadError message={history.message} retryHref={HISTORY_HREF} />;

  // Without the catalogue the sentences stay generic ("A role") rather than failing the page.
  const labels = catalogue.ok ? labelsFrom(catalogue.data) : NO_LABELS;
  if (history.data.length === 0) {
    return (
      <EmptyState title="No access changes yet">
        Changes to access and departments show here.
      </EmptyState>
    );
  }

  return (
    <Table caption="Access history" minWidth={640}>
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Who</Th>
          <Th>What changed</Th>
        </tr>
      </thead>
      <tbody>
        {history.data.map((event) => (
          <tr key={`${event.chainMonth}:${event.seq}`}>
            <Td nowrap>{formatInstant(event.occurredAt)}</Td>
            <Td>{actorName(event)}</Td>
            <Td>{describeChange(event, labels)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
