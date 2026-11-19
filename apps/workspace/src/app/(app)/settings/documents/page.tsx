import { DEFAULT_DOCUMENT_STYLE, DocumentStyleSchema } from '@bos/contracts';
import type { Metadata } from 'next';

import { DocumentStyleForm } from '@/components/settings/documents/document-style-form';
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

export default async function DocumentsSettingsPage() {
  const session = await requireSection('documents');
  const loaded = await section('view the document style', async () => {
    const current = await getSetting(session, 'document.style');
    // A stored value this screen cannot read falls back to the built-in default, as the API does.
    const parsed = DocumentStyleSchema.safeParse(current.value);
    const style = parsed.success ? parsed.data : DEFAULT_DOCUMENT_STYLE;
    // loadPreviews never rejects: a layout that cannot be drawn becomes a placeholder card.
    return { style, previews: await loadPreviews(session, style.primaryColour) };
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
            initial={loaded.data.style}
            initialPreviews={loaded.data.previews}
            saveAction={saveDocumentStyleAction}
            previewsAction={previewsAction}
          />
        ) : (
          <SectionError message={loaded.message} />
        )}
      </div>
    </Page>
  );
}
