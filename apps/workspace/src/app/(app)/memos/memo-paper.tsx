import type { MemoTemplateSnapshot } from '@bos/contracts';
import styles from './memo-template.module.css';

export function MemoPaper({
  template,
  title,
  body,
}: {
  template: MemoTemplateSnapshot;
  title: string;
  body: string;
}) {
  const people = [
    { label: 'Prepared by', person: template.preparedBy },
    ...template.recommenders.map((person, i) => ({ label: `Recommended by ${i + 1}`, person })),
    { label: 'Approved by', person: template.approvedBy },
  ];
  return (
    <article className={styles.paper} aria-label="Memo preview">
      <header>
        <strong>{template.organizationName}</strong>
        <div>{template.departmentName}</div>
        <div>(MEMO)</div>
      </header>
      <p className={styles.date}>Date: {template.date}</p>
      <h2 className={styles.subject}>Subject: {title || 'Untitled memo'}</h2>
      <div className={styles.body}>
        {body.split(/\n\s*\n/).map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
      <p className={styles.closing}>{template.closing}</p>
      <div className={styles.signers}>
        {people.map(({ label, person }) => (
          <section key={label}>
            <p>{label}</p>
            <strong>{person.name || 'Not selected'}</strong>
            {person.jobTitle ? <div>{person.jobTitle}</div> : null}
          </section>
        ))}
      </div>
      <p className={styles.note}>
        Names indicate the proposed approval route. Signatures are disabled.
      </p>
    </article>
  );
}
