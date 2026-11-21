import { describe, expect, it } from 'vitest';

import { receiveAction } from './receive-action';

const line = (kind: 'goods' | 'service', openQuantity: string, pendingQuantity = '0.0000') => ({
  kind,
  openQuantity,
  pendingQuantity,
});
const WAREHOUSE = { confirm: true };
const BOTH = { goods: true, service: true };

describe('receiveAction (the PO detail receive button)', () => {
  it('offers nothing when every line is fully received or reserved by draft receipts', () => {
    // Old page: offered Receive goods on can.receive alone, with nothing left to receive.
    expect(
      receiveAction(true, { lines: [line('goods', '0.0000')], can: BOTH }, WAREHOUSE),
    ).toBeNull();
    expect(
      receiveAction(true, { lines: [line('goods', '3.0000', '3.0000')], can: BOTH }, WAREHOUSE),
    ).toBeNull();
  });

  it('offers nothing for a kind the person may not receive, even with room left', () => {
    expect(
      receiveAction(
        true,
        { lines: [line('goods', '5.0000')], can: { goods: false, service: true } },
        WAREHOUSE,
      ),
    ).toBeNull();
  });

  it('says Receive goods while a goods line has room, even beside service lines', () => {
    expect(receiveAction(true, { lines: [line('goods', '5.0000')], can: BOTH }, WAREHOUSE)).toBe(
      'Receive goods',
    );
    expect(
      receiveAction(
        true,
        { lines: [line('goods', '5.0000'), line('service', '1.0000')], can: BOTH },
        WAREHOUSE,
      ),
    ).toBe('Receive goods');
  });

  it('says Receive service when only service lines are offered', () => {
    expect(
      receiveAction(
        true,
        { lines: [line('goods', '0.0000'), line('service', '1.0000')], can: BOTH },
        WAREHOUSE,
      ),
    ).toBe('Receive service');
    // A requester without the warehouse grant: goods are not theirs to receive.
    expect(
      receiveAction(
        true,
        { lines: [line('goods', '5.0000'), line('service', '1.0000')] },
        { confirm: false },
      ),
    ).toBe('Receive service');
  });

  it("follows the order's can.receive first, and leaves an unloaded progress to it", () => {
    expect(
      receiveAction(false, { lines: [line('goods', '5.0000')], can: BOTH }, WAREHOUSE),
    ).toBeNull();
    expect(receiveAction(true, undefined, WAREHOUSE)).toBe('Receive goods');
    expect(receiveAction(false, undefined, WAREHOUSE)).toBeNull();
  });
});
