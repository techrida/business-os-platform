import { avatarColour, imagePath } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NextFollowUpCell, OwnerCell } from './lead-cells';

const NOW = new Date('2026-11-19T06:00:00Z');

describe('NextFollowUpCell', () => {
  it('marks a past follow-up with the word Overdue in the warning tone', () => {
    const html = renderToStaticMarkup(<NextFollowUpCell at="2026-11-18T04:15:00Z" now={NOW} />);
    expect(html).toContain('Overdue');
    expect(html).toMatch(/class="[^"]*warning[^"]*"[^>]*>Overdue</);
    expect(html).toContain('dateTime="2026-11-18T04:15:00Z"');
  });

  it('shows a future follow-up as a plain date', () => {
    const html = renderToStaticMarkup(<NextFollowUpCell at="2026-11-20T04:15:00Z" now={NOW} />);
    expect(html).not.toContain('Overdue');
    expect(html).toContain('<time');
  });

  it('treats a follow-up due this very minute as not yet overdue', () => {
    const html = renderToStaticMarkup(<NextFollowUpCell at={NOW.toISOString()} now={NOW} />);
    expect(html).not.toContain('Overdue');
  });

  it('says none is planned when the lead has no open follow-up', () => {
    const html = renderToStaticMarkup(<NextFollowUpCell at={null} now={NOW} />);
    expect(html).toContain('None planned');
    expect(html).not.toContain('Overdue');
  });
});

describe('OwnerCell', () => {
  it('shows initials and the owner name', () => {
    const html = renderToStaticMarkup(<OwnerCell owned name="Asha Gurung" />);
    expect(html).toContain('>AG<');
    expect(html).toContain('Asha Gurung');
  });

  it("seeds the colour from the owner's user id and shows their picture", () => {
    const owner = '9f1c2e4a-6b7d-4e8f-a1b2-c3d4e5f60718';
    const picture = '66666666-6666-4666-8666-666666666666';
    const html = renderToStaticMarkup(
      <OwnerCell owned name="Asha Gurung" seedId={owner} imageDocumentId={picture} />,
    );
    // The id must not land on the unseeded colour, or this check would pass without a seed.
    expect(avatarColour(owner)).not.toBe(avatarColour(null));
    expect(html).toContain(`--avatar-fill:${avatarColour(owner)}`);
    expect(html).toContain(`src="${imagePath(picture)}"`);
  });

  it('never shows an id when the name is unknown', () => {
    expect(renderToStaticMarkup(<OwnerCell owned name={undefined} />)).toContain(
      'Name unavailable',
    );
    expect(renderToStaticMarkup(<OwnerCell owned={false} name={undefined} />)).toContain(
      'No owner',
    );
  });
});
