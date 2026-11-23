// @vitest-environment jsdom
import type { DocumentLayout } from '@bos/contracts';
import { DOCUMENT_LAYOUTS } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE, ok, type ActionState } from '@/app/(app)/settings/action-state';
import type { DocumentPreviews } from '@/app/(app)/settings/documents/previews';
import { click, mountForm } from '@/test/form-interactions';

import { DocumentStyleForm } from './document-style-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const previewsFor = (tag: string, skip?: DocumentLayout): DocumentPreviews =>
  Object.fromEntries(
    DOCUMENT_LAYOUTS.map((layout) => [layout, layout === skip ? null : `<p>${tag} ${layout}</p>`]),
  ) as DocumentPreviews;

const saveAction = vi.fn<(previous: ActionState, formData: FormData) => Promise<ActionState>>();
const previewsAction = vi.fn<(colour: string) => Promise<DocumentPreviews | null>>();

beforeEach(() => {
  saveAction.mockReset().mockResolvedValue(ok('Document style saved.'));
  previewsAction.mockReset().mockImplementation((colour) => Promise.resolve(previewsFor(colour)));
});

const mount = (skip?: DocumentLayout) =>
  mountForm(
    <DocumentStyleForm
      initial={{ layout: 'banded', primaryColour: '#1d4ed8' }}
      initialPreviews={previewsFor('first', skip)}
      saveAction={saveAction}
      previewsAction={previewsAction}
    />,
  );

const radio = (root: HTMLElement, layout: string) =>
  root.querySelector<HTMLButtonElement>(`button[role="radio"][value="${layout}"]`);
const saveButton = (root: HTMLElement) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
const dot = (root: HTMLElement, label: string) =>
  root.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`);

describe('DocumentStyleForm', () => {
  it('draws five design-system radios with the saved layout selected, and a sandboxed frame in each card', async () => {
    const { container, unmount } = await mount();
    expect(container.querySelectorAll('button[role="radio"]')).toHaveLength(5);
    expect(radio(container, 'banded')?.getAttribute('aria-checked')).toBe('true');
    const frames = container.querySelectorAll('iframe');
    expect(frames).toHaveLength(5);
    for (const frame of frames) {
      expect(frame.getAttribute('sandbox')).toBe('');
      expect(frame.tabIndex).toBe(-1);
    }
    // The expand button is beside the label, never inside it.
    for (const expand of container.querySelectorAll('button[aria-label^="Preview"]')) {
      expect(expand.closest('label')).toBeNull();
    }
    await unmount();
  });

  it('shows a neutral card with the layout name where a preview failed', async () => {
    const { container, unmount } = await mount('ledger');
    expect(container.querySelectorAll('iframe')).toHaveLength(4);
    const placeholder = container.querySelector('[data-state="unavailable"]');
    expect(placeholder?.textContent).toContain('Ledger');
    expect(placeholder?.textContent).toContain('Preview unavailable');
    await unmount();
  });

  it('keeps Save disabled until the layout or the colour differs from what is saved', async () => {
    const { container, unmount } = await mount();
    expect(saveButton(container).disabled).toBe(true);
    await click(radio(container, 'tinted'));
    expect(saveButton(container).disabled).toBe(false);
    await click(radio(container, 'banded'));
    expect(saveButton(container).disabled).toBe(true);
    await click(dot(container, 'Teal'));
    expect(saveButton(container).disabled).toBe(false);
    await unmount();
  });

  it('submits exactly the layout and the colour, then treats the saved pair as the new baseline', async () => {
    const { container, unmount } = await mount();
    await click(radio(container, 'side-labels'));
    await click(dot(container, 'Crimson'));
    await click(saveButton(container));
    expect(saveAction).toHaveBeenCalledTimes(1);
    const sent = saveAction.mock.calls[0]![1];
    expect([...sent.keys()].sort()).toEqual(['layout', 'primaryColour']);
    expect(sent.get('layout')).toBe('side-labels');
    expect(sent.get('primaryColour')).toBe('#be123c');
    expect(saveAction.mock.calls[0]![0]).toEqual(IDLE);
    expect(saveButton(container).disabled).toBe(true);
    await unmount();
  });

  it('marks the chosen preset as pressed and shows its contrast reading', async () => {
    const { container, unmount } = await mount();
    expect(dot(container, 'Ocean')?.getAttribute('aria-pressed')).toBe('true');
    await click(dot(container, 'Slate'));
    expect(dot(container, 'Slate')?.getAttribute('aria-pressed')).toBe('true');
    expect(dot(container, 'Ocean')?.getAttribute('aria-pressed')).toBe('false');
    expect(container.textContent).toMatch(/(Good|Excellent) contrast, \d+\.\d:1/);
    expect(container.textContent).toContain('It does not change this app');
    await unmount();
  });

  it('asks for new previews with one request at a time, sending only the latest colour after it', async () => {
    const pending: Array<(value: DocumentPreviews) => void> = [];
    previewsAction.mockImplementation(
      () => new Promise<DocumentPreviews>((resolve) => pending.push(resolve)),
    );
    const { container, unmount } = await mount();
    await click(dot(container, 'Teal'));
    await click(dot(container, 'Forest'));
    await click(dot(container, 'Amber'));
    // One in flight; the newer clicks are only remembered, and the old previews stay on screen.
    expect(previewsAction).toHaveBeenCalledTimes(1);
    expect(previewsAction).toHaveBeenLastCalledWith('#0f766e');
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('first');
    const { act } = await import('react');
    await act(() => {
      pending[0]!(previewsFor('teal'));
      return Promise.resolve();
    });
    expect(previewsAction).toHaveBeenCalledTimes(2);
    expect(previewsAction).toHaveBeenLastCalledWith('#b45309');
    await act(() => {
      pending[1]!(previewsFor('amber'));
      return Promise.resolve();
    });
    expect(previewsAction).toHaveBeenCalledTimes(2);
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('amber');
    await unmount();
  });

  it('keeps the old previews and says so when a refresh fails', async () => {
    previewsAction.mockResolvedValue(null);
    const { container, unmount } = await mount();
    await click(dot(container, 'Teal'));
    expect(previewsAction).toHaveBeenCalledTimes(1);
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('first');
    expect(container.textContent).toContain('could not be refreshed');
    await unmount();
  });

  it('opens a full-size preview from the expand button without selecting the layout', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const { container, unmount } = await mount();
    await click(container.querySelector('button[aria-label="Preview Ledger at full size"]'));
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Ledger layout');
    expect(dialog?.querySelector('iframe')?.getAttribute('srcdoc')).toContain('ledger');
    expect(radio(container, 'banded')?.getAttribute('aria-checked')).toBe('true');
    await unmount();
    vi.unstubAllGlobals();
  });
});
