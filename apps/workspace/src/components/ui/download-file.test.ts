// The file name a route's Content-Disposition gives (round 4, R4c2: in-app download): the RFC 5987 form first, then
// the quoted and bare forms; no folders; nothing usable means the caller's own name.
import { describe, expect, it } from 'vitest';

import { filenameFromDisposition } from './download-file';

describe('filenameFromDisposition', () => {
  it('reads the quoted, bare and UTF-8 forms, the UTF-8 one first', () => {
    expect(filenameFromDisposition('attachment; filename="INV-2083-84-00001.pdf"')).toBe(
      'INV-2083-84-00001.pdf',
    );
    expect(filenameFromDisposition('attachment; filename=PO-1-v2.pdf')).toBe('PO-1-v2.pdf');
    expect(
      filenameFromDisposition(
        `attachment; filename="fallback.pdf"; filename*=UTF-8''Quotation%20%E0%A4%95.pdf`,
      ),
    ).toBe('Quotation क.pdf');
  });

  it('keeps no folder in the name, and gives null for nothing usable', () => {
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe(
      '..-..-etc-passwd',
    );
    expect(filenameFromDisposition('attachment; filename=""')).toBeNull();
    expect(filenameFromDisposition('attachment')).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
