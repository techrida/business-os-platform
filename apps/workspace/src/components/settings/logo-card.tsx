'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { ImageUpload } from '@/components/ui/image-upload';
import { Panel } from '@/components/ui/panel';

import type { CompanyLogo } from './company-profile';
import styles from './company-editor.module.css';

const DESCRIPTION = 'Printed at the top of your quotations, invoices, purchase orders and memos.';
const LEGACY_NOTE =
  'Your current logo still prints while it is moved to the new picture storage. Upload a new one to replace it.';

/**
 * The logo card. Dropping or choosing a file uploads it at once (UIP-FORM-001) and makes it the logo, so this card
 * has no Save button; the preview dialog (UIP-FORM-003) and the remove button (UIP-FORM-002) come from ImageUpload.
 * A logo saved before logos were uploaded images shows as a preview-only picture beside the upload box until the API
 * moves it; an upload replaces it.
 */
export function LogoCard({
  organisationId,
  name,
  logo,
}: {
  /** The organisation the logo belongs to: the `entity_logo` owner and the initials colour. */
  organisationId: string;
  /** The company name: initials, alt text and the names of the controls. */
  name: string;
  logo: CompanyLogo;
}) {
  const router = useRouter();
  const legacy = logo.legacyDataUrl;

  return (
    <Panel title="Logo" description={legacy ? `${DESCRIPTION} ${LEGACY_NOTE}` : DESCRIPTION}>
      {/* One wrapper in every state: ImageUpload must not remount when the old logo gives way to an upload, or it
          loses its Scanning state. */}
      <div className={styles.logo} data-empty={legacy ? undefined : 'true'}>
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
        <ImageUpload
          ownerType="entity_logo"
          ownerId={organisationId}
          imageDocumentId={logo.documentId}
          name={name}
          seedId={organisationId}
          shape="square"
          fit="contain"
          label="Company logo"
          onChange={() => router.refresh()}
        />
      </div>
    </Panel>
  );
}
