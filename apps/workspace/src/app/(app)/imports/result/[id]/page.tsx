import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { ApiError } from '@/lib/api';
import { failureOf } from '@/lib/api-kernel';
import { getImport } from '@/lib/api-imports';
import { requireStaffSession } from '@/lib/bff';

import { IMPORT_KINDS, slugOfKind, STATUS_LABEL } from '../../_lib/import-view';
import styles from '../../imports.module.css';
import { commitImportAction } from './actions';

export const metadata: Metadata = { title: 'Import result · Business OS' };
export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONE = { valid: 'info', created: 'success', duplicate: 'warning', error: 'error' } as const;

export default async function ImportResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { id } = await params;
  if (!GUID.test(id)) notFound();
  const session = await requireStaffSession(`/imports/result/${id}`);
  const query = await searchParams;
  const notice = typeof query.error === 'string' ? query.error.slice(0, 300) : undefined;
  let batch;
  try {
    batch = await getImport(session, id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <Page>
        <PageHeader title="Import result" />
        <Alert tone="error" role="alert" title="The import did not load">
          {failureOf(err).message}
        </Alert>
      </Page>
    );
  }
  const slug = slugOfKind(batch.kind);
  const meta = IMPORT_KINDS[slug];
  const committed = batch.status === 'committed';
  // A preview left for 7 days was cleared by the worker: its rows are gone, so there is nothing to review or import.
  const expired = batch.status === 'expired';
  const refused = batch.rowCount - batch.validCount - batch.createdCount;
  return (
    <Page>
      <Breadcrumb
        items={[
          { label: meta.plural[0]!.toUpperCase() + meta.plural.slice(1), href: meta.listHref },
          { label: 'Import from CSV', href: `/imports/${slug}` },
          { label: batch.fileName },
        ]}
      />
      <PageHeader
        title={
          committed
            ? `Imported ${batch.fileName}`
            : expired
              ? `Expired ${batch.fileName}`
              : `Check ${batch.fileName}`
        }
        description={
          committed
            ? `Imported ${batch.committedAt?.slice(0, 16).replace('T', ' ') ?? ''}. This record stays as it is.`
            : expired
              ? 'Nothing was created. The preview was not imported within 7 days, so its rows were deleted.'
              : `Nothing has been created yet. Review the rows, then import the ${batch.validCount} that are ready.`
        }
      />
      <div className={styles.stack}>
        {notice ? (
          <Alert tone="error" role="alert" title="The import was not completed">
            {notice}
          </Alert>
        ) : null}
        <section className={styles.stats} aria-label="Rows by result">
          <StatCard label="Rows in the file" value={batch.rowCount} icon="list-checks" />
          <StatCard
            label={
              committed
                ? `${meta.plural[0]!.toUpperCase()}${meta.plural.slice(1)} created`
                : 'Ready to import'
            }
            value={committed ? batch.createdCount : batch.validCount}
            icon="check-circle"
          />
          <StatCard label="Already exist (skipped)" value={batch.duplicateCount} icon="repeat" />
          <StatCard label="Need fixing (skipped)" value={batch.errorCount} icon="alert-triangle" />
        </section>
        <div className={styles.actions}>
          {!committed && !expired && batch.validCount > 0 ? (
            <form action={commitImportAction}>
              <input type="hidden" name="id" value={batch.id} />
              <Button type="submit">
                Import {batch.validCount} {batch.validCount === 1 ? meta.singular : meta.plural}
              </Button>
            </form>
          ) : null}
          {refused > 0 && !expired ? (
            <LinkButton variant="secondary" href={`/imports/result/${batch.id}/errors`}>
              Download the error report
            </LinkButton>
          ) : null}
          <LinkButton variant="secondary" href={committed ? meta.listHref : `/imports/${slug}`}>
            {committed ? `Back to ${meta.plural}` : 'Upload a different file'}
          </LinkButton>
        </div>
        {expired ? (
          <Alert tone="warning" title="This preview expired.">
            Upload the file again to check it and import it.
          </Alert>
        ) : null}
        {!committed && !expired && batch.validCount === 0 ? (
          <Alert tone="warning">
            No row is ready to import. Fix the rows listed below in your file and upload it again.
          </Alert>
        ) : null}
        {expired ? null : (
          <Panel title="Rows">
            <Table caption="Rows of the import" minWidth={760}>
              <thead>
                <tr>
                  <Th>Line</Th>
                  <Th>Name / PAN</Th>
                  <Th>Result</Th>
                  <Th>Problems</Th>
                </tr>
              </thead>
              <tbody>
                {batch.rows.map((row) => (
                  <tr key={row.line}>
                    <Td nowrap>{row.line}</Td>
                    <Td>
                      <span className={styles.long}>
                        {row.name === '' ? '(no name)' : row.name}
                      </span>
                      <div className={styles.quiet}>{row.pan ?? 'No PAN'}</div>
                    </Td>
                    <Td>
                      <Badge tone={TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                    </Td>
                    <Td>
                      {row.issues.length === 0 ? (
                        <span className={styles.quiet}>None</span>
                      ) : (
                        <ul className={styles.issues}>
                          {row.issues.map((issue, index) => (
                            <li key={index} className={styles.long}>
                              {issue.column === null
                                ? ''
                                : `${issue.column.replaceAll('_', ' ')}: `}
                              {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
      </div>
    </Page>
  );
}
