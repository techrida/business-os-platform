'use client';

import type { EntityLogoOwnerType } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import { useId, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { ImageUpload } from '@/components/ui/image-upload';
import { Panel } from '@/components/ui/panel';

import { BosMark } from './bos-mark';
import type { CompanyLogo } from './company-profile';
import styles from './company-editor.module.css';

const DESCRIPTION =
  'Printed at the top of your quotations, invoices, purchase orders and memos. Upload the main logo; add one for dark or light backgrounds only if the main one is hard to read on them.';
const LEGACY_NOTE =
  'Your current logo still prints while it is moved to the new picture storage. Upload a new one to replace it.';

/** The background each slot's picture and example sit on: the colour that logo is made for. */
export type LogoStage = 'neutral' | 'dark' | 'light';

/** The colours behind the stage (theme-independent: a dark logo must stay on white in dark mode too). */
export const LOGO_STAGE_BACKGROUND: Record<Exclude<LogoStage, 'neutral'>, string> = {
  dark: 'var(--neutral-950)',
  light: 'var(--neutral-0)',
};

interface SlotSpec {
  ownerType: EntityLogoOwnerType;
  title: string;
  stage: LogoStage;
  optional: boolean;
  /** What an empty slot says it is for, used as the example's caption and in the screen-reader text. */
  purpose: string;
}

const SLOTS: readonly SlotSpec[] = [
  {
    ownerType: 'entity_logo',
    title: 'Logo',
    stage: 'neutral',
    optional: false,
    purpose: 'the main logo',
  },
  {
    ownerType: 'entity_logo_on_dark',
    title: 'Logo for dark backgrounds',
    stage: 'dark',
    optional: true,
    purpose: 'dark backgrounds, usually a white or light version of the logo',
  },
  {
    ownerType: 'entity_logo_on_light',
    title: 'Logo for light backgrounds',
    stage: 'light',
    optional: true,
    purpose: 'light backgrounds, usually a dark version of the logo',
  },
];

/**
 * What an empty slot shows: the Business OS mark on the background that slot is for, dimmed and captioned "Example", so
 * it is never taken for an uploaded file. Screen readers get the sentence that the slot is empty.
 */
export function LogoPlaceholder({ stage, slotTitle }: { stage: LogoStage; slotTitle: string }) {
  return (
    <span className={styles.placeholder} data-stage={stage} data-testid="logo-placeholder">
      <span className={styles.placeholderMark} aria-hidden="true">
        <BosMark />
      </span>
      <span className={styles.placeholderCaption} aria-hidden="true">
        Example
      </span>
      <span className="sr-only">{`${slotTitle}: nothing uploaded. The Business OS logo shown is only an example.`}</span>
    </span>
  );
}

/**
 * One slot: its label row (name left, a muted "Optional" right, UIP-FORM-008), then the upload with its preview on the
 * slot's own background. Dropping or choosing a file uploads at once (UIP-FORM-001); the preview dialog
 * (UIP-FORM-003) and the remove button (UIP-FORM-002) come from ImageUpload.
 */
function LogoSlot({
  slot,
  organisationId,
  name,
  documentId,
  disabled,
  note,
  onChange,
}: {
  slot: SlotSpec;
  organisationId: string;
  name: string;
  documentId: string | null;
  disabled: boolean;
  note: ReactNode;
  onChange: () => void;
}) {
  const labelId = useId();
  const stageBackground = slot.stage === 'neutral' ? undefined : LOGO_STAGE_BACKGROUND[slot.stage];
  return (
    <div className={styles.slot} role="group" aria-labelledby={labelId}>
      <div className={styles.slotLabelRow}>
        <span id={labelId} className={styles.slotLabel}>
          {slot.title}
        </span>
        {slot.optional ? <span className={styles.optional}>Optional</span> : null}
      </div>
      <ImageUpload
        ownerType={slot.ownerType}
        ownerId={organisationId}
        imageDocumentId={documentId}
        name={slot.optional ? `${name} ${slot.title.toLowerCase()}` : name}
        seedId={organisationId}
        shape="square"
        fit="contain"
        size="xlarge"
        label={slot.title}
        disabled={disabled}
        stageBackground={stageBackground}
        placeholder={<LogoPlaceholder stage={slot.stage} slotTitle={slot.title} />}
        onChange={onChange}
      />
      {note ? <p className={styles.slotNote}>{note}</p> : null}
    </div>
  );
}

/**
 * The logo card: the main logo and two optional ones, for dark and for light backgrounds. A document uses the main
 * logo unless it would be hard to see on the header it lands on, then the one made for that background, then a
 * one-colour copy of the main logo (the server decides from measured contrast, WCAG 1.4.11). The variants wait for a
 * main logo, since nothing is printed without it. A logo saved before logos were uploaded images shows as a
 * preview-only picture until the API moves it; an upload replaces it.
 */
export function LogoCard({
  organisationId,
  name,
  logo,
}: {
  /** The organisation the logo belongs to: the logo owner and the initials colour. */
  organisationId: string;
  /** The company name: initials, alt text and the names of the controls. */
  name: string;
  logo: CompanyLogo;
}) {
  const router = useRouter();
  const legacy = logo.legacyDataUrl;
  const ids: Record<EntityLogoOwnerType, string | null> = {
    entity_logo: logo.documentId,
    entity_logo_on_dark: logo.onDarkDocumentId,
    entity_logo_on_light: logo.onLightDocumentId,
  };
  const hasMain = logo.documentId !== null || legacy !== null;

  return (
    <Panel title="Logo" description={legacy ? `${DESCRIPTION} ${LEGACY_NOTE}` : DESCRIPTION}>
      <div className={styles.slots}>
        {legacy ? (
          <Dialog
            trigger={
              <button type="button" className={styles.thumb} aria-label={`View ${name} logo`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a stored data URL: drawn through <img> only */}
                <img className={styles.thumbImage} src={legacy} alt={`${name} logo`} />
              </button>
            }
            title="Company logo"
            description={name}
            size="medium"
            footer={
              <DialogClose asChild>
                <Button variant="secondary">Close</Button>
              </DialogClose>
            }
          >
            <div className={styles.previewStage}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a stored data URL */}
              <img className={styles.previewImage} src={legacy} alt={`${name} logo`} />
            </div>
          </Dialog>
        ) : null}
        {/* One wrapper per slot in every state: ImageUpload must not remount when the old logo gives way to an
            upload, or it loses its Scanning state. */}
        {SLOTS.map((slot) => (
          <LogoSlot
            key={slot.ownerType}
            slot={slot}
            organisationId={organisationId}
            name={name}
            documentId={ids[slot.ownerType]}
            disabled={slot.optional && !hasMain}
            note={slot.optional && !hasMain ? 'Upload the main logo first.' : null}
            onChange={() => router.refresh()}
          />
        ))}
      </div>
    </Panel>
  );
}
