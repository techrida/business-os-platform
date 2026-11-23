// The colour the logo is chosen against (logoBackgroundHex in @bos/contracts) must be the colour each layout really
// draws behind it, or a "white logo on the blue header" would land on something else. Each layout's CSS is held to it.
import {
  DOCUMENT_LAYOUTS,
  EMPTY_SNAPSHOT_COMPANY_PROFILE,
  logoBackgroundHex,
  type DocumentLayout,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { renderQuotationHtml } from './quotation-html';
import { sampleQuotationView } from './sample-view';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function html(layout: DocumentLayout, primaryColour: string): string {
  return renderQuotationHtml(sampleQuotationView(), {
    snapshot: {
      style: { layout, primaryColour },
      profile: { ...EMPTY_SNAPSHOT_COMPANY_PROFILE, logoDataUrl: PNG },
      numberSystems: { NPR: 'south_asian' } as never,
      capturedAt: '2026-11-23T00:00:00.000Z',
    },
  });
}

describe('the background a quotation layout draws behind the logo', () => {
  it.each(['#1d4ed8', '#0f766e', '#b45309'])(
    'banded: the band is the colour the logo is chosen against (%s)',
    (primary) => {
      const band = /\.band \{[^}]*background: (#[0-9a-f]{6})/i.exec(html('banded', primary));
      expect(band?.[1]?.toLowerCase()).toBe(
        logoBackgroundHex({ layout: 'banded', primaryColour: primary }),
      );
    },
  );

  it('banded: the logo sits on the band itself, not on a white plate', () => {
    expect(html('banded', '#1d4ed8')).not.toMatch(/\.brand--logo \{[^}]*background/);
  });

  it('tinted: the band is the tint the logo is chosen against', () => {
    const band = /\.band \{[^}]*background: (#[0-9a-f]{6})/i.exec(html('tinted', '#1d4ed8'));
    expect(band?.[1]?.toLowerCase()).toBe(
      logoBackgroundHex({ layout: 'tinted', primaryColour: '#1d4ed8' }),
    );
  });

  it.each(DOCUMENT_LAYOUTS.filter((l) => l !== 'banded' && l !== 'tinted'))(
    '%s: the logo is on white paper',
    (layout) => {
      expect(logoBackgroundHex({ layout, primaryColour: '#1d4ed8' })).toBe('#ffffff');
      expect(html(layout, '#1d4ed8')).not.toMatch(/\.brand--logo \{[^}]*background/);
    },
  );
});
