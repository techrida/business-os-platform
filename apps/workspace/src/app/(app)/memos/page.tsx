import type { Metadata } from 'next';
import Link from 'next/link';

import { requireStaffSession } from '@/lib/bff';

import styles from '../kit.module.css';
import { OpenMemoForm } from './open-memo-form';

export const metadata: Metadata = { title: 'Memos · Business OS' };

export default async function MemosPage() {
  await requireStaffSession('/memos');
  return (
    <main id="main" className={`${styles.page} ${styles.narrow}`}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Memos</h1>
          <p className={styles.sub}>
            Test memos that exercise numbering, attachments, approvals and the audit trail.
          </p>
        </div>
        <Link href="/memos/new" className={styles.btn}>
          New memo
        </Link>
      </div>

      <div className={styles.stack}>
        <section className={styles.panel} aria-labelledby="open-h">
          <h2 id="open-h" className={styles.panelTitle}>
            Open a memo
          </h2>
          <p className={styles.panelNote}>
            A memo you created opens right after you save it. To come back to one, use the link in
            its notification, or paste its id here.
          </p>
          <OpenMemoForm />
        </section>
      </div>
    </main>
  );
}
