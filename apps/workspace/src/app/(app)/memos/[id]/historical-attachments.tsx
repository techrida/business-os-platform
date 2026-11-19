import { Badge } from '@/components/ui/badge';
import { ViewDocument } from '@/components/ui/view-document';
import { type AttachmentView, baseMime, formatBytes, scanLabel } from '@/lib/kernel-ui';

import styles from '../../kit.module.css';
import { PaperclipIcon } from '../memo-icons';

const BADGE_TONE = { good: 'success', wait: 'warning', bad: 'error' } as const;

/**
 * Files that were attached to a memo in P1, shown read-only. Internal memos no longer take uploads, so there is
 * no form here and nothing polls for a scan: a file is either clean, and opens in the document viewer (with a
 * Download link beside it), or it is not, and only its status is shown. Serves the NFR "no unscanned file is ever
 * served": the viewer and link exist for `clean` only.
 */
export function HistoricalAttachments({ files }: { files: AttachmentView[] }) {
  return (
    <ul className={styles.files} aria-label="Attachments">
      {files.map((f) => {
        const scan = scanLabel(f.status);
        const mime = baseMime(f.detectedMime ?? null) || 'application/octet-stream';
        const base = `/api/documents/${encodeURIComponent(f.documentId)}/versions/${encodeURIComponent(f.id)}`;
        return (
          <li key={f.id} className={styles.file}>
            <span className={styles.fileIcon}>
              <PaperclipIcon size={18} />
            </span>
            <div className={styles.fileText}>
              <span className={styles.fileName}>{f.filename}</span>
              <span className={styles.fileSize}>{formatBytes(f.sizeBytes)}</span>
            </div>
            <div className={styles.fileSide}>
              <Badge tone={BADGE_TONE[scan.tone]}>{scan.text}</Badge>
              {f.status === 'clean' ? (
                <ViewDocument
                  name={f.filename}
                  mimeType={mime}
                  label={mime === 'application/pdf' ? 'View PDF' : 'View'}
                  previewUrl={`${base}/preview`}
                  downloadUrl={`${base}/download`}
                  size="small"
                  withDownload
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
