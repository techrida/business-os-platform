import {
  DEFAULT_BRAND_COLOUR,
  deriveBrandPalette,
  HexColourSchema,
  LogoDataUrlSchema,
  type MemoTemplateSnapshot,
} from '@bos/contracts';
import { NOT_SELECTED } from '@/lib/memo-pdf-input';

import styles from './memo-template.module.css';

/**
 * The letterhead band's values. A memo stored before letterheads has none: it still gets the band, with the
 * default brand colour, no address and no logo. A colour or logo that fails its contract is dropped, never drawn.
 */
function bandOf(template: MemoTemplateSnapshot) {
  const letterhead = template.letterhead;
  const colour = HexColourSchema.safeParse(letterhead?.primaryColour);
  const logo = LogoDataUrlSchema.safeParse(letterhead?.logoDataUrl);
  return {
    palette: deriveBrandPalette(colour.success ? colour.data : DEFAULT_BRAND_COLOUR),
    addressLines: (letterhead?.addressLines ?? []).filter((line) => line.trim() !== ''),
    logo: logo.success ? logo.data : null,
  };
}

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
  const band = bandOf(template);
  return (
    <article id={id} data-memo-paper="" className={styles.paper} aria-label="Memo preview">
      {/* Colours are inline: the print frame's `[data-memo-paper] * { color: inherit }` would beat a class. */}
      <header className={styles.band} style={{ backgroundColor: band.palette.tint }}>
        <p className={styles.bandTitle} style={{ color: band.palette.accentText }}>
          Memo
        </p>
        <div className={styles.bandCompany}>
          <div className={styles.bandText}>
            {/* Name, department, then the address: the order the PDF prints (memo-pdf.ts). */}
            <strong className={styles.bandName}>{template.organizationName}</strong>
            {template.departmentName ? (
              <span className={styles.bandDepartment}>{template.departmentName}</span>
            ) : null}
            {band.addressLines.map((line, i) => (
              <span key={`${i}:${line}`} className={styles.bandLine}>
                {line}
              </span>
            ))}
          </div>
          {band.logo ? (
            // A data URL that passed LogoDataUrlSchema (PNG, JPEG or WebP): drawn through <img> only, never inlined.
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.bandLogo} src={band.logo} alt={template.organizationName} />
          ) : null}
        </div>
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
