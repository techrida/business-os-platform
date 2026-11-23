// @vitest-environment jsdom
// The pick-existing field (UIP-FORM-009): one live-search box, no Search button, the id posts under the field name.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Field } from '@/components/ui/field';
import type { ComboboxOption } from '@/components/ui/combobox-model';
import { fill, mountForm, settle } from '@/test/form-interactions';

import { PickExisting, SEARCH_FAILED_TEXT, type PickSearcher } from './pick-existing';
import { listedOptions, pickBox, pickByTyping } from './pick-existing.test-helpers';

const OPTIONS: ComboboxOption[] = [
  { id: 'v1', label: 'Himal Traders', description: 'PAN 111111111' },
  { id: 'v2', label: 'Everest Supplies', description: 'PAN 222222222' },
];

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

function Host({ search }: { search?: PickSearcher }) {
  const [value, setValue] = useState('');
  return (
    <form>
      <Field label="Vendor">
        {(control) => (
          <PickExisting
            control={control}
            name="vendorId"
            options={OPTIONS}
            value={value}
            onChange={setValue}
            noMatchText="No vendor matches."
            search={search}
            searchDelayMs={0}
          />
        )}
      </Field>
    </form>
  );
}

const posted = (container: HTMLElement) =>
  new FormData(container.querySelector('form')!).get('vendorId');

describe('PickExisting', () => {
  it('filters the loaded list while typing, shows what matched, has no Search button and posts the id', async () => {
    mounted = await mountForm(<Host />);
    const { container } = mounted;
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull(); // the search icon inside the box
    await fill(pickBox(container, 'vendorId'), '2222');
    // The tax id is matched and shown beside the name; no Create row, a pick-existing field.
    expect(listedOptions()).toEqual(['Everest SuppliesPAN 222222222']);
    await fill(pickBox(container, 'vendorId'), 'nobody');
    expect(document.body.textContent).toContain('No vendor matches.');
    expect(listedOptions()).toEqual([]);
    await pickByTyping(container, 'vendorId', 'himal', 'Himal Traders');
    expect(posted(container)).toBe('v1');
  });

  it('asks the server for the typed words when the list is only the first page, and posts the id it returns', async () => {
    const far: ComboboxOption = { id: 'v9', label: 'Karnali Metals', description: 'PAN 999999999' };
    const search = vi.fn<PickSearcher>().mockResolvedValue([far]);
    mounted = await mountForm(<Host search={search} />);
    const { container } = mounted;
    await fill(pickBox(container, 'vendorId'), 'karnali');
    await settle();
    expect(search).toHaveBeenCalledWith('karnali', expect.anything());
    expect(listedOptions()).toEqual(['Karnali MetalsPAN 999999999']);
    await pickByTyping(container, 'vendorId', 'karnali', 'Karnali Metals');
    expect(posted(container)).toBe('v9');
    expect(pickBox(container, 'vendorId').value).toBe('Karnali Metals');
    // Editing the text after a pick unlinks the vendor.
    await fill(pickBox(container, 'vendorId'), 'Karnali Metal');
    expect(posted(container)).toBe('');
  });

  it('does not ask the server for one letter: the loaded list is narrowed here', async () => {
    const search = vi.fn<PickSearcher>().mockResolvedValue([]);
    mounted = await mountForm(<Host search={search} />);
    const { container } = mounted;
    await fill(pickBox(container, 'vendorId'), 'h');
    await settle();
    expect(search).not.toHaveBeenCalled();
    expect(listedOptions()).toEqual(['Himal TradersPAN 111111111']);
    // Two letters is enough for the server.
    await fill(pickBox(container, 'vendorId'), 'hi');
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('hi', expect.anything());
  });

  it('says the search did not load, not that no vendor matches, when the server refuses; the next good answer clears it', async () => {
    const far: ComboboxOption = { id: 'v9', label: 'Karnali Metals', description: 'PAN 999999999' };
    const search = vi
      .fn<PickSearcher>()
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue([far]);
    mounted = await mountForm(<Host search={search} />);
    const { container } = mounted;
    await fill(pickBox(container, 'vendorId'), 'karnali');
    await settle();
    expect(listedOptions()).toEqual([]);
    expect(document.body.textContent).toContain(SEARCH_FAILED_TEXT);
    expect(document.body.textContent).not.toContain('No vendor matches.');
    await fill(pickBox(container, 'vendorId'), 'karnal');
    await settle();
    expect(listedOptions()).toEqual(['Karnali MetalsPAN 999999999']);
    expect(document.body.textContent).not.toContain(SEARCH_FAILED_TEXT);
  });
});
