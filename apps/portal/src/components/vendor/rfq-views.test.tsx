import { forbiddenPortalKeys } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AFTER_DEADLINE,
  BEFORE_DEADLINE,
  RFQ_ID,
  sampleRfq,
  sampleRfqListItem,
} from './rfq-fixtures';
import { RfqList } from './rfq-list';
import { RfqView } from './rfq-view';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('RFQ fixtures', () => {
  it('carry no key a vendor must not see', () => {
    for (const data of [sampleRfq(), sampleRfqListItem()]) {
      expect(forbiddenPortalKeys(data)).toEqual([]);
    }
  });
});

describe('RfqList', () => {
  it('lists number and deadline in Nepal time, with a plain link per row', () => {
    const html = renderToStaticMarkup(
      <RfqList items={[sampleRfqListItem()]} now={BEFORE_DEADLINE} />,
    );
    const t = text(html);
    expect(html).toContain(`href="/vendor/rfqs/${RFQ_ID}"`);
    expect(t).toContain('RFQ-2082-0012');
    // 08:15 UTC is 14:00 in Kathmandu.
    expect(t).toContain('20 Nov 2026, 14:00');
    expect(t).toContain('Nepal time');
    expect(t).toContain('Open for quotations');
    expect(t).not.toContain('Deadline passed');
    expect(html).toContain('<caption');
  });

  it('marks a deadline that has passed, in words, and keeps the row linked', () => {
    const html = renderToStaticMarkup(
      <RfqList items={[sampleRfqListItem()]} now={AFTER_DEADLINE} />,
    );
    expect(text(html)).toContain('Deadline passed');
    expect(html).toContain(`href="/vendor/rfqs/${RFQ_ID}"`);
  });

  it('shows an empty state when there are no requests', () => {
    const html = renderToStaticMarkup(<RfqList items={[]} now={BEFORE_DEADLINE} />);
    expect(text(html)).toContain('No requests for quotation yet');
    expect(html).not.toContain('<table');
  });

  it('keeps a very long number wrappable', () => {
    const number = `RFQ-${'9'.repeat(28)}`;
    const html = renderToStaticMarkup(
      <RfqList items={[sampleRfqListItem({ number })]} now={BEFORE_DEADLINE} />,
    );
    expect(html).toContain(number);
    expect(html).toMatch(/class="[^"]*rowLink/);
  });
});

describe('RfqView', () => {
  it('shows the number, deadline in Nepal time, trimmed quantities and the quotation link', () => {
    const html = renderToStaticMarkup(<RfqView view={sampleRfq()} now={BEFORE_DEADLINE} />);
    const t = text(html);
    expect(t).toContain('RFQ-2082-0012');
    expect(t).toContain('20 Nov 2026, 14:00');
    expect(t).toContain('Nepal time');
    expect(t).toContain('Cat6 patch cable');
    expect(t).toContain('120');
    expect(t).not.toContain('120.0000');
    expect(t).toContain('2.5');
    expect(t).not.toContain('2.5000');
    expect(html).toMatch(new RegExp(`<a [^>]*href="/vendor/rfqs/${RFQ_ID}/quote"[^>]*>`));
    expect(t).toContain('Submit quotation');
    expect(t).not.toContain('deadline for this request has passed');
    expect(html).toContain('<caption');
  });

  it('after the deadline drops the quotation link and says why, and keeps long text wrappable (F1-Q47)', () => {
    const html = renderToStaticMarkup(<RfqView view={sampleRfq()} now={AFTER_DEADLINE} />);
    const t = text(html);
    expect(t).toContain('The deadline for this request has passed');
    expect(t).toContain('20 Nov 2026, 14:00');
    expect(t).toContain('We can no longer take a quotation for this request.');
    expect(html).not.toContain(`href="/vendor/rfqs/${RFQ_ID}/quote"`);
    expect(t).not.toContain('Submit quotation');
    expect(t).toContain('five-year onsite warranty');
  });

  it('says so when there are no lines, instead of an empty table', () => {
    const html = renderToStaticMarkup(
      <RfqView view={sampleRfq({ lines: [] })} now={BEFORE_DEADLINE} />,
    );
    expect(html).not.toContain('<table');
    expect(text(html)).toContain('No items are listed on this request yet');
  });
});
