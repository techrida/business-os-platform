'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Table, Td, Th } from '@/components/ui/table';

import styles from './detail.module.css';

/**
 * One revision, already formatted on the server. The drawer takes strings and server-rendered
 * nodes (the status badge, the PDF link or words) so this client file pulls in no money, date or
 * contract code.
 */
export interface RevisionRow {
  id: string;
  /** "Rev 2". */
  label: string;
  /** The detail page showing this revision: `?rev=<id>`, or the bare path for the current one. A page link, never a document link. */
  href: string;
  current: boolean;
  status: ReactNode;
  /** The server's total for this revision, formatted. */
  total: string;
  validUntil: string;
  /** Why this revision was made, when it was a revision of an earlier one. */
  note: string | null;
  pdf: ReactNode;
}

/** Lists every revision of a quotation, including superseded revisions. */
export function VersionDrawer({ number, rows }: { number: string; rows: readonly RevisionRow[] }) {
  return (
    <Dialog
      trigger={
        <Button variant="secondary" size="small">
          All revisions ({rows.length})
        </Button>
      }
      title={`Revisions of ${number}`}
      description="Newest first. A superseded revision stays here as a record."
      size="large"
      footer={
        <DialogClose asChild>
          <Button variant="secondary">Close</Button>
        </DialogClose>
      }
    >
      {rows.length === 0 ? (
        <p className={styles.note}>No revisions yet.</p>
      ) : (
        <Table caption={`Revisions of ${number}`} minWidth={720}>
          <thead>
            <tr>
              <Th>Revision</Th>
              <Th>Status</Th>
              <Th align="end">Total</Th>
              <Th>Valid until</Th>
              <Th>PDF</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <div className={styles.revision}>
                    <span className={styles.revisionName}>
                      <DialogClose asChild>
                        <Link href={row.href} prefetch={false}>
                          {row.label}
                        </Link>
                      </DialogClose>
                      {row.current ? <Badge tone="info">Current</Badge> : null}
                    </span>
                    {row.note !== null ? (
                      <span className={styles.revisionNote}>{row.note}</span>
                    ) : null}
                  </div>
                </Td>
                <Td nowrap>{row.status}</Td>
                <Td align="end" nowrap>
                  {row.total}
                </Td>
                <Td nowrap>{row.validUntil}</Td>
                <Td nowrap>{row.pdf}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Dialog>
  );
}
