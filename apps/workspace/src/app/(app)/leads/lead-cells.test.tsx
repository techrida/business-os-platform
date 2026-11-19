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
    const html = renderToStaticMarkup(<OwnerCell name="Asha Gurung" />);
    expect(html).toContain('>AG<');
    expect(html).toContain('Asha Gurung');
  });

  it('says no owner only when the lead has none, and has no unavailable state', () => {
    expect(renderToStaticMarkup(<OwnerCell name={null} />)).toContain('No owner');
    expect(renderToStaticMarkup(<OwnerCell name="Unnamed user" />)).not.toContain('unavailable');
  });
});
