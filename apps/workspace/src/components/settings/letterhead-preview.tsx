import { Panel } from '@/components/ui/panel';

import { addressLines, type AddressDraft } from './company-profile';
import styles from './company-editor.module.css';

export interface LetterheadModel {
  logo: string | null;
  displayName: string;
  address: AddressDraft;
  phones: readonly string[];
  email: string;
  website: string;
  panVatNo: string;
}

/**
 * The top of a document as it will print: logo, name, address, phones, email, website and PAN or VAT.
 * It reads the drafts of every card, so it changes as the person types, before anything is saved.
 * An empty part shows a quiet placeholder so the person sees what is still missing.
 */
export function LetterheadPreview({ model }: { model: LetterheadModel }) {
  const name = model.displayName.trim();
  const address = addressLines(model.address);
  const phones = model.phones.map((p) => p.trim()).filter(Boolean);
  const email = model.email.trim();
  const website = model.website.trim();
  const pan = model.panVatNo.trim();
  const contact = [phones.join(' · '), email, website].filter(Boolean);

  return (
    <Panel
      as="aside"
      title="Letterhead preview"
      description="The top of your documents, as it will print."
      className={styles.aside}
    >
      <div className={styles.sheet}>
        {model.logo ? (
          // A data URL the person just chose or saved: drawn through <img> only, never inlined.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.sheetLogo} src={model.logo} alt="Company logo" />
        ) : null}
        <p className={`${styles.sheetName} ${name ? '' : styles.sheetEmpty}`}>
          {name || 'Company name'}
        </p>
        <ul className={styles.sheetLines}>
          {address.length > 0 ? (
            address.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)
          ) : (
            <li className={styles.sheetEmpty}>Address not set</li>
          )}
          {contact.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {pan ? <li>PAN/VAT: {pan}</li> : null}
        </ul>
      </div>
    </Panel>
  );
}
