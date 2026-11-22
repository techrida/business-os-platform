'use client';

import { formatPhoneForPrint } from '@bos/contracts';
import { useEffect, useState } from 'react';

import { scanPollDelays } from '@/components/ui/image-upload';
import { Panel } from '@/components/ui/panel';

import { addressLines, type AddressDraft } from './company-profile';
import styles from './company-editor.module.css';

export interface LetterheadModel {
  /** Where the logo is read from: `/api/images/:id`, a logo not yet moved (data URL), or null for none. */
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
  const phones = model.phones
    .map((p) => p.trim())
    .filter(Boolean)
    .map(formatPhoneForPrint);
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
        {model.logo ? <SheetLogo key={model.logo} src={model.logo} /> : null}
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

/**
 * The logo on the sheet. A just-uploaded logo answers 404 until its virus scan is done, so a failed load is hidden
 * and tried again on the same backoff ImageUpload uses (about a minute in all); after that the sheet goes without.
 * The parent keys this on `src`, so a new logo starts over.
 */
function SheetLogo({ src }: { src: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!failed) return;
    const delay = scanPollDelays()[attempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      setAttempt((value) => value + 1);
      setFailed(false);
    }, delay);
    return () => clearTimeout(timer);
  }, [failed, attempt]);

  if (failed) return null;
  return (
    // Same-origin image route or a stored data URL: drawn through <img> only, never inlined.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={attempt}
      className={styles.sheetLogo}
      src={src}
      alt="Company logo"
      onError={() => setFailed(true)}
    />
  );
}
