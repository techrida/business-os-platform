// The record an approval is about, as it stands now (U18 #2), beside the snapshot taken at submit. The API serves it
// under the approval request's own read, so an approver without a read grant on the record still sees what they
// judge. The record's page is linked only when the API returned a link (the reader may open it); a file is listed
// only when the reader may open it through the documents routes.
import { CurrencySchema, type ApprovalContext, type ApprovalContextField } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { FilePreviewDialog } from '@/components/ui/file-preview-dialog';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { money, when } from '@/lib/kernel-format';
import { humanizeKey } from '@/lib/kernel-ui';

import styles from '../inbox.module.css';

function shown(field: ApprovalContextField, numberSystems: NumberSystems): string {
  switch (field.kind) {
    case 'money': {
      const currency = CurrencySchema.safeParse(field.currency);
      return currency.success
        ? money(field.value, currency.data, numberSystems)
        : `${field.value} ${field.currency ?? ''}`.trim();
    }
    case 'date':
      return when(field.value, 'date');
    case 'status':
      return humanizeKey(field.value);
    default:
      return field.value;
  }
}

export function CurrentRecord({
  context,
  numberSystems,
}: {
  context: ApprovalContext;
  numberSystems: NumberSystems;
}) {
  const facts: Fact[] = context.fields.map((field) => ({
    key: field.key,
    label: field.label,
    value: shown(field, numberSystems),
  }));
  return (
    <Panel
      title="Current record"
      className={styles.detailPanel}
      description="The record as it stands now. The submitted details above show what was sent for approval."
    >
      <p>
        {context.href !== null ? <Link href={context.href}>{context.title}</Link> : context.title}
      </p>
      {facts.length > 0 ? <FactList facts={facts} /> : null}
      {context.documents.length > 0 ? (
        <ul className={styles.frozenFiles} aria-label="Files of the record">
          {context.documents.map((file) => {
            const base = `/api/documents/${file.documentId}/versions/${file.versionId}`;
            return (
              <li key={file.versionId}>
                <FilePreviewDialog
                  name={file.filename}
                  mimeType={file.detectedMime ?? 'application/octet-stream'}
                  previewUrl={`${base}/preview`}
                  downloadUrl={`${base}/download`}
                  trigger={<Button variant="secondary">{file.filename}</Button>}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </Panel>
  );
}
