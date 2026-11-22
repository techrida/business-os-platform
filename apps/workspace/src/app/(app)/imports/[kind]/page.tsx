import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { listImports } from '@/lib/api-imports';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import {
  IMPORT_KINDS,
  importSlugOf,
  LIMITS_TEXT,
  requiredColumns,
  templateColumns,
} from '../_lib/import-view';
import styles from '../imports.module.css';

export const metadata: Metadata = { title: 'Import from CSV · Business OS' };
export const dynamic = 'force-dynamic';

export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const slug = importSlugOf((await params).kind);
  if (slug === null) notFound();
  const meta = IMPORT_KINDS[slug];
  const session = await requireStaffSession(`/imports/${slug}`);
  const query = await searchParams;
  const uploadError = typeof query.error === 'string' ? query.error.slice(0, 300) : undefined;
  const crumbs = [
    { label: meta.plural[0]!.toUpperCase() + meta.plural.slice(1), href: meta.listHref },
    { label: 'Import from CSV' },
  ];
  const header = (
    <>
      <Breadcrumb items={crumbs} />
      <PageHeader title={meta.title} description={meta.help} />
    </>
  );
  // Live grants (GET /v1/me), not the role defaults: the API still decides every call.
  if (!hasGrant(await getGrants(session), meta.grant))
    return (
      <Page>
        {header}
        <Alert tone="info" role="alert">
          Your roles do not include importing {meta.plural}. Ask an administrator if you need to.
        </Alert>
      </Page>
    );
  let history: Awaited<ReturnType<typeof listImports>> = [];
  let historyError: string | undefined;
  try {
    history = await listImports(session, meta.kind);
  } catch (err) {
    historyError = failureOf(err).message;
  }
  const required = requiredColumns(meta.kind);
  return (
    <Page>
      {header}
      <div className={styles.stack}>
        {uploadError ? (
          <Alert tone="error" role="alert" title="The file was not accepted">
            {uploadError}
          </Alert>
        ) : null}
        <Panel title="Upload a file">
          <ol className={styles.steps}>
            <li>
              <a href={`/imports/${slug}/template`}>Download the template</a> and fill one row per{' '}
              {meta.singular}. Required columns: {required.join(', ')}. All columns:{' '}
              {templateColumns(meta.kind).join(', ')}.
            </li>
            <li>
              Upload the file. You see every row checked, with its errors, before anything is
              created.
            </li>
            <li>
              Import the rows that are ready. Rows that need fixing or already exist are skipped.
            </li>
          </ol>
          <form
            method="post"
            action={`/imports/${slug}/upload`}
            encType="multipart/form-data"
            className={styles.upload}
          >
            <Field label="CSV file" hint={LIMITS_TEXT}>
              {(control) => (
                <input
                  type="file"
                  name="file"
                  accept=".csv,text/csv"
                  required
                  className={styles.file}
                  {...control}
                />
              )}
            </Field>
            <div className={styles.actions}>
              <Button type="submit">Check the file</Button>
              <LinkButton href={meta.listHref} variant="secondary">
                Cancel
              </LinkButton>
            </div>
          </form>
        </Panel>
        <Panel title="Recent imports">
          {historyError ? (
            <Alert tone="error" role="alert">
              {historyError}
            </Alert>
          ) : history.length === 0 ? (
            <p className={styles.quiet}>No imports yet.</p>
          ) : (
            <Table caption="Recent imports" minWidth={640}>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>File</Th>
                  <Th>Status</Th>
                  <Th align="end">Rows</Th>
                  <Th align="end">Created</Th>
                </tr>
              </thead>
              <tbody>
                {history.map((batch) => (
                  <tr key={batch.id}>
                    <Td nowrap>{batch.createdAt.slice(0, 16).replace('T', ' ')}</Td>
                    <Td>
                      <Link href={`/imports/result/${batch.id}`} className={styles.long}>
                        {batch.fileName}
                      </Link>
                    </Td>
                    <Td>
                      {batch.status === 'committed'
                        ? 'Imported'
                        : batch.status === 'expired'
                          ? 'Expired'
                          : 'Not imported yet'}
                    </Td>
                    <Td align="end">{batch.rowCount}</Td>
                    <Td align="end">{batch.createdCount}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </Page>
  );
}
