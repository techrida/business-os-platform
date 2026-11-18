import type { AttachmentView } from '@/lib/kernel-ui';

const MISSING_BY_STATUS: Record<string, string> = {
  quarantined: 'Scan running',
  awaiting_content: 'Scan running',
  infected: 'Virus found',
  rejected: 'File rejected',
};

/**
 * What still stops a memo from being submitted, as short pill labels: one per kind of problem, in the order the
 * files list them. Empty when every attachment is clean (or there are none). The API makes the same check when
 * Submit is pressed; this only tells the person early.
 */
export function submitMissing(files: readonly Pick<AttachmentView, 'status'>[]): string[] {
  const missing = new Set<string>();
  for (const file of files) {
    if (file.status === 'clean') continue;
    missing.add(MISSING_BY_STATUS[file.status] ?? 'Scan failed');
  }
  return [...missing];
}
