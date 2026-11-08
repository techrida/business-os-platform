'use client';

import { useId, useRef, type MouseEvent, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
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
  current: boolean;
  status: ReactNode;
  /** The server's total for this revision, formatted. */
  total: string;
  validUntil: string;
  /** Why this revision was made, when it was a revision of an earlier one. */
  note: string | null;
  pdf: ReactNode;
}

/**
 * "All revisions" for one quotation: a button that opens a native modal dialog listing every
 * revision, Superseded ones included, with its status, total and PDF. The browser traps focus in
 * the dialog, closes it on Esc and puts focus back on the button. Read-only: it changes nothing.
 */
export function VersionDrawer({ number, rows }: { number: string; rows: readonly RevisionRow[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const subId = useId();

  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();
  // A click on the dim area outside the box (the dialog has no padding, so only the backdrop
  // reports itself as the target). Esc and the buttons are the keyboard routes.
  const closeOnBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) close();
  };

  return (
    <>
      <Button variant="secondary" size="small" onClick={open}>
        All revisions ({rows.length})
      </Button>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={subId}
        onClick={closeOnBackdrop}
      >
        <div className={styles.dialogBox}>
          <div className={styles.dialogHead}>
            <div className={styles.dialogTitle}>
              <h2 id={titleId}>Revisions of {number}</h2>
              <p id={subId} className={styles.dialogSub}>
                Newest first. A superseded revision stays here as a record.
              </p>
            </div>
            <Button
              variant="ghost"
              size="small"
              className={styles.dialogClose ?? ''}
              onClick={close}
              aria-label="Close"
            >
              <Icon name="x" size={18} />
            </Button>
          </div>
          <div className={styles.dialogBody}>
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
                            {row.label}
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
          </div>
          <div className={styles.dialogFoot}>
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
