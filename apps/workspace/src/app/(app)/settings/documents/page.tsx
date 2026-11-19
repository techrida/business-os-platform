import {
  DEFAULT_DOCUMENT_STYLE,
  DOCUMENT_LAYOUT_LABELS,
  DocumentStyleSchema,
  PRESET_BRAND_COLOURS,
} from '@bos/contracts';
import type { Metadata } from 'next';

import { isDefaultValue } from '@/components/settings/default-value';
import { DocumentStyleForm } from '@/components/settings/documents/document-style-form';
import { ResetToDefaultButton } from '@/components/settings/reset-to-default';
import { Page, PageHeader } from '@/components/ui/page';
import { getSetting } from '@/lib/api-admin';

import { BackToSettings } from '../_components/back-link';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { previewsAction, saveDocumentStyleAction } from './actions';
import { loadPreviews } from './previews';

export const metadata: Metadata = { title: 'Document templates · Business OS' };

const DEFAULT_STYLE_TEXT = `${DOCUMENT_LAYOUT_LABELS[DEFAULT_DOCUMENT_STYLE.layout].name}, ${
  PRESET_BRAND_COLOURS.find((preset) => preset.hex === DEFAULT_DOCUMENT_STYLE.primaryColour)
    ?.name ?? DEFAULT_DOCUMENT_STYLE.primaryColour
}`;

export default async function DocumentsSettingsPage() {
  const session = await requireSection('documents');
  const loaded = await section('view the document style', async () => {
    const current = await getSetting(session, 'document.style');
    // A stored value this screen cannot read falls back to the built-in default, as the API does.
    const parsed = DocumentStyleSchema.safeParse(current.value);
    const style = parsed.success ? parsed.data : DEFAULT_DOCUMENT_STYLE;
    // loadPreviews never rejects: a layout that cannot be drawn becomes a placeholder card.
    return {
      style,
      // A stored value this screen cannot read is not the default: the undo icon stays available.
      isDefault: isDefaultValue('document.style', current.value),
      // Sent back with a reset, so a screen that is out of date cannot overwrite a newer save.
      version: current.version,
      previews: await loadPreviews(session, style.primaryColour),
    };
  });

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Document templates"
        description="Changes apply to new documents and drafts. Documents already sent keep the look they were sent with."
      />
      <div className={`${styles.column} ${styles.narrow}`}>
        {loaded.ok ? (
          <DocumentStyleForm
            // Keyed on the saved style, so an undo remounts the form with fresh values.
            key={`${loaded.data.style.layout}:${loaded.data.style.primaryColour}`}
            initial={loaded.data.style}
            initialPreviews={loaded.data.previews}
            saveAction={saveDocumentStyleAction}
            previewsAction={previewsAction}
            actions={
              <ResetToDefaultButton
                section="documents"
                settingKey="document.style"
                label="Document style"
                isDefault={loaded.data.isDefault}
                loadedVersion={loaded.data.version}
                defaultText={DEFAULT_STYLE_TEXT}
              />
            }
          />
        ) : (
          <SectionError message={loaded.message} />
        )}
      </div>
    </Page>
  );
}
