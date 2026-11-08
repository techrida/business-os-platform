import type { Metadata } from 'next';
import Link from 'next/link';

import { requireStaffSession } from '@/lib/bff';

import styles from '../../kit.module.css';
import { createMemoAction } from '../actions';
import { MemoForm } from '../memo-form';

export const metadata: Metadata = { title: 'New memo · Business OS' };

export default async function NewMemoPage() {
  await requireStaffSession('/memos/new');
  return (
    <main id="main" className={`${styles.page} ${styles.narrow}`}>
      <Link href="/memos" className={styles.back}>
        Back to memos
      </Link>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>New memo</h1>
          <p className={styles.sub}>
            Save it as a draft first. You can attach files and see the approval route before you
            submit.
          </p>
        </div>
      </div>
      <section className={styles.panel} aria-label="Memo details">
        <MemoForm
          action={createMemoAction}
          initial={{ title: '', body: '', amount: '', currency: 'NPR' }}
          submitLabel="Save draft"
        />
      </section>
    </main>
  );
}
