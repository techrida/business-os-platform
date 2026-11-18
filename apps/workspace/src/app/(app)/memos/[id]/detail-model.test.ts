import { describe, expect, it } from 'vitest';

import { submitMissing } from './detail-model';

describe('submitMissing', () => {
  it('is empty with no attachments or only clean ones', () => {
    expect(submitMissing([])).toEqual([]);
    expect(submitMissing([{ status: 'clean' }])).toEqual([]);
  });

  it('names one pill per kind of problem, not per file', () => {
    expect(
      submitMissing([
        { status: 'quarantined' },
        { status: 'awaiting_content' },
        { status: 'clean' },
        { status: 'infected' },
        { status: 'rejected' },
        { status: 'something_new' },
      ]),
    ).toEqual(['Scan running', 'Virus found', 'File rejected', 'Scan failed']);
  });
});
