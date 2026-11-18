import type { MemoTemplateSnapshot } from '@bos/contracts';
import { NOT_SELECTED } from '@/lib/memo-pdf-input';

import styles from './memo-template.module.css';

export function MemoPaper({
  template,
  title,
  body,
  id,
}: {
  template: MemoTemplateSnapshot;
  title: string;
  body: string;
  /** Lets the Print action find exactly this paper and nothing else on the page. */
  id?: string;
}) {
  const people = [
    { label: 'Prepared by', person: template.preparedBy },
    ...template.recommenders.map((person, i) => ({ label: `Recommended by ${i + 1}`, person })),
    { label: 'Approved by', person: template.approvedBy },
  ];
  return (
    <article id={id} data-memo-paper="" className={styles.paper} aria-label="Memo preview">
      <header>
        <strong>{template.organizationName}</strong>
        <div>{template.departmentName}</div>
        <div>(MEMO)</div>
      </header>
      <p className={styles.date}>Date: {template.date || 'Not set'}</p>
      <h2 className={styles.subject}>Subject: {title || 'Untitled memo'}</h2>
      <div className={styles.body}>
        {body
          .replace(/\r\n?/g, '\n')
          .split(/\n\s*\n/)
          .map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
      </div>
      <p className={styles.closing}>{template.closing}</p>
      <div className={styles.signers}>
        {people.map(({ label, person }) => (
          <section key={label}>
            <p>{label}</p>
            <strong>{person.name || NOT_SELECTED}</strong>
            {person.jobTitle ? <div>{person.jobTitle}</div> : null}
          </section>
        ))}
      </div>
    </article>
  );
}
