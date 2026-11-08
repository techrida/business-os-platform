import type { InboxItemDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { getInbox, failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

import { Notice } from '../kit';
import styles from '../kit.module.css';

export const metadata: Metadata = { title: 'Inbox · Business OS' };
export const dynamic = 'force-dynamic';

/** What the banner says after a decision. Only these keys are accepted from the query string. */
const DECIDED: Record<string, string> = {
  approve: 'Your approval was recorded.',
  return: 'The request was returned to the person who prepared it.',
  reject: 'The request was rejected.',
};

function InboxRow({ item }: { item: InboxItemDto }) {
  return (
    <li className={styles.item}>
      <div>
        <Link href={`/inbox/${encodeURIComponent(item.requestId)}`} className={styles.rowLink}>
          {item.title}
        </Link>
        <span className={styles.docNumber}>{item.documentNumber}</span>
      </div>
      {/* The reason is the point of the inbox: why this one is yours. */}
      <p className={styles.reason}>
        <span className={styles.visuallyHidden}>Why it is yours: </span>
        {item.reason}
      </p>
      <div className={`${styles.numeric} ${styles.amount}`}>
        <span className={styles.visuallyHidden}>Amount: </span>
        {item.amountNpr !== null ? (
          money(item.amountNpr, 'NPR')
        ) : (
          <span className={styles.meta}>No amount</span>
        )}
      </div>
      <div className={`${styles.meta} ${styles.numeric}`}>
        <span className={styles.visuallyHidden}>Submitted: </span>
        <time dateTime={item.submittedAt}>{when(item.submittedAt)}</time>
      </div>
    </li>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ decided?: string | string[] }>;
}) {
  const session = await requireStaffSession('/inbox');
  const { decided } = await searchParams;
  const decidedKey = typeof decided === 'string' ? decided : undefined;
  const banner = decidedKey !== undefined ? DECIDED[decidedKey] : undefined;

  let items: InboxItemDto[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await getInbox(session);
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  return (
    <main id="main" className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Inbox</h1>
          <p className={styles.sub}>
            Documents waiting for your decision. Each shows why the approval route sent it to you.
          </p>
        </div>
        {items !== null && items.length > 0 ? (
          <p className={styles.meta} role="status">
            {items.length} waiting
          </p>
        ) : null}
      </div>

      {banner !== undefined ? (
        <div className={styles.stack} style={{ marginBottom: '1rem' }}>
          <Notice tone="ok" role="status">
            <p>{banner}</p>
          </Notice>
        </div>
      ) : null}

      {problem !== null ? (
        <Notice tone="bad" role="alert">
          <p>
            <strong>
              {problem.status === 403
                ? 'Your roles do not include approvals'
                : 'The inbox did not load'}
            </strong>
          </p>
          <p>
            {problem.status === 403
              ? 'The inbox is for people who approve documents. If you prepare documents, open Memos to follow yours.'
              : problem.message}
          </p>
          {problem.status !== 403 ? (
            <p>
              <Link href="/inbox">Reload the inbox</Link>
            </p>
          ) : null}
        </Notice>
      ) : items !== null && items.length === 0 ? (
        <p className={styles.empty}>
          <strong>Nothing is waiting for you.</strong>
          New approvals appear here, and the bell above tells you when one arrives.
        </p>
      ) : items !== null ? (
        <ul className={styles.list} aria-label="Waiting approvals">
          {items.map((item) => (
            <InboxRow key={item.requestId} item={item} />
          ))}
        </ul>
      ) : null}
    </main>
  );
}
