// Dev menu: a floating developer/QA widget. Vanilla DOM inside a Shadow DOM host so the app's
// CSS cannot reach it and it cannot reach the app's CSS. Identity inspection uses the real
// app session; Accounts uses the privileged local development login client. Loaded from src/instrumentation-client.ts behind a development-only
// guard, so it is absent from production builds.
import { formatWhoami, parseState, serializeState, type DevMenuState } from './dev-menu-state';

const STORAGE_KEY = 'bos.dev.menu';
const WHOAMI_URL = '/dev/api/whoami';
const DISPOSE_KEY = Symbol.for('bos.dev.menu.dispose');
// An open modal (Radix dialogs carry role=dialog and data-state=open; a native <dialog> has [open]).
// The chip floats above the page, so it would sit on the dialog's own buttons.
const MODAL_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]';

const STYLES = `
:host { all: initial; }
[hidden] { display: none !important; }
* { box-sizing: border-box; }
.root {
  position: fixed;
  left: 12px;
  bottom: 84px;
  z-index: 2147483000;
  font: 12px/16px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #f9fafb;
}
/* Beside the app's sidebar, never over it: at 12px from the left the chip covered the rail's
   Settings link on a tablet. The shell's sizes are custom properties, which reach the shadow root
   by inheritance (all: initial leaves them alone). Below 768px the sidebar is a drawer. */
@media (min-width: 768px) {
  .root { left: calc(var(--bos-rail-width, 108px) + 12px); }
}
@media (min-width: 1024px) {
  .root { left: calc(var(--bos-sidebar-width, 220px) + 12px); }
}
button {
  position: relative;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  min-width: 40px;
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button:focus-visible { outline: none; }
button:focus-visible .face { outline: 2px solid #93c5fd; outline-offset: 2px; }
.face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  background: #111827;
  border: 1px solid #374151;
  font-weight: 600;
  transition: transform 150ms ease-out;
}
button:active .face { transform: scale(0.97); }
.pill { margin-left: -4px; }
.dot {
  position: absolute;
  left: -15px;
  bottom: -15px;
}
.dot .face {
  min-height: 10px;
  width: 10px;
  min-width: 10px;
  padding: 0;
  border: 0;
  background: #6b7280;
}
.panel {
  position: absolute;
  left: 0;
  bottom: calc(100% + 4px);
  width: 280px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 12px;
  border-radius: 8px;
  background: #111827;
  border: 1px solid #374151;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  transform-origin: bottom left;
  opacity: 0;
  transform: translateY(4px);
  visibility: hidden;
  pointer-events: none;
  transition: opacity 150ms ease-out, transform 150ms ease-out, visibility 0s linear 150ms;
}
.panel.open {
  opacity: 1;
  transform: none;
  visibility: visible;
  pointer-events: auto;
  transition-delay: 0s;
}
.head, .section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.title { font-size: 14px; line-height: 20px; font-weight: 600; margin: 0; }
.section { margin-top: 12px; padding-top: 12px; border-top: 1px solid #374151; }
.section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.action .face {
  min-height: 24px;
  padding: 0 8px;
  border-radius: 4px;
  background: #1f2937;
  border: 1px solid #374151;
  font-weight: 500;
}
.action::after { content: ''; position: absolute; inset: -8px -4px; }
.rows { margin: 8px 0 0; display: grid; gap: 8px; }
.row { display: grid; gap: 2px; }
.row dt { margin: 0; color: #9ca3af; }
.row dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
}
.note { margin: 8px 0 0; color: #d1d5db; }
@media (prefers-reduced-motion: reduce) {
  .panel { transform: none; transition: opacity 150ms ease-out, visibility 0s linear 150ms; }
  .panel.open { transition-delay: 0s; }
  button:active .face { transform: none; }
  .face { transition: none; }
}
`;

type Attrs = Record<string, string>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, attrs: Attrs = {}): HTMLButtonElement {
  const node = el('button', { type: 'button', class: className, ...attrs });
  node.append(el('span', { class: 'face' }, label));
  return node;
}

function readState(): DevMenuState {
  try {
    return parseState(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseState(null);
  }
}

function writeState(state: DevMenuState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeState(state));
  } catch {
    // Storage can be blocked or full. The menu still works for this page view.
  }
}

function mount(): () => void {
  document.querySelectorAll('[data-marker="BOS_DEV_MENU"]').forEach((node) => node.remove());

  const host = el('div', { 'data-marker': 'BOS_DEV_MENU' });
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(el('style', {}, STYLES));

  const root = el('div', { class: 'root', id: 'bos-dev-root' });
  const pill = button('pill', 'Dev', {
    'aria-expanded': 'false',
    'aria-controls': 'bos-dev-panel',
    'aria-label': 'Dev menu',
  });
  const dot = button('dot', '', {
    'aria-expanded': 'false',
    'aria-controls': 'bos-dev-root',
    'aria-label': 'Show dev menu',
  });

  const panel = el('div', {
    class: 'panel',
    id: 'bos-dev-panel',
    role: 'region',
    'aria-label': 'Dev tools',
  });
  const hideButton = button('action', 'Hide', { 'aria-controls': 'bos-dev-root' });
  const refreshButton = button('action', 'Refresh', { 'aria-controls': 'bos-dev-whoami' });
  const whoami = el('div', { id: 'bos-dev-whoami', 'aria-live': 'polite' });

  const head = el('div', { class: 'head' });
  head.append(el('h2', { class: 'title' }, 'Dev tools'), hideButton);

  const whoamiSection = el('section', { class: 'section' });
  const whoamiHead = el('div', { class: 'section-head' });
  whoamiHead.append(el('h3', { class: 'section-title' }, 'Who am I'), refreshButton);
  whoamiSection.append(whoamiHead, whoami);

  const accountsSection = el('section', { class: 'section' });
  accountsSection.append(
    el('h3', { class: 'section-title' }, 'Accounts'),
    el('p', { class: 'note' }, 'Loading accounts…'),
  );

  panel.append(head, whoamiSection, accountsSection);
  root.append(pill, dot, panel);
  shadow.append(root);
  document.body.append(host);

  let state = readState();
  let loadedOnce = false;
  let requestId = 0;

  function showNote(text: string): void {
    whoami.replaceChildren(el('p', { class: 'note' }, text));
  }

  async function loadAccounts(): Promise<void> {
    try {
      const response = await fetch('/dev/api/accounts', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Unavailable');
      const data = (await response.json()) as {
        accounts: { id: string; label: string; login: string }[];
      };
      const list = el('div', { class: 'rows' });
      for (const account of data.accounts) {
        const form = el('form', { method: 'post', action: '/dev/api/accounts' });
        const input = el('input', { type: 'hidden', name: 'account', value: account.id });
        const entry = button('action', account.label, { title: account.login });
        entry.type = 'submit';
        form.append(input, entry);
        form.addEventListener('submit', () => {
          list.querySelectorAll('button').forEach((node) => {
            node.disabled = true;
          });
          entry.setAttribute('aria-busy', 'true');
        });
        list.append(form);
      }
      accountsSection.replaceChildren(el('h3', { class: 'section-title' }, 'Accounts'), list);
    } catch {
      accountsSection.replaceChildren(
        el('h3', { class: 'section-title' }, 'Accounts'),
        el('p', { class: 'note' }, 'Accounts unavailable. Check development login-client setup.'),
      );
    }
  }

  async function loadWhoami(): Promise<void> {
    const mine = ++requestId;
    showNote('Loading…');
    try {
      const response = await fetch(WHOAMI_URL, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (mine !== requestId) return;
      if (response.status === 401) return showNote('Signed out');
      if (response.status !== 200) return showNote(`Could not load (${response.status})`);
      const view = formatWhoami(await response.json());
      if (mine !== requestId) return;
      if (view.kind === 'signed-out') return showNote('Signed out');
      if (view.kind === 'error') return showNote(`Could not load (${view.message})`);
      const list = el('dl', { class: 'rows' });
      for (const [label, value] of view.rows) {
        const row = el('div', { class: 'row' });
        row.append(el('dt', {}, label), el('dd', {}, value));
        list.append(row);
      }
      whoami.replaceChildren(list);
    } catch {
      if (mine === requestId) showNote('Could not load (network error)');
    }
  }

  let modalOpen = false;

  function render(): void {
    root.hidden = modalOpen;
    pill.hidden = state.hidden;
    dot.hidden = !state.hidden;
    panel.hidden = state.hidden;
    const open = state.open && !state.hidden;
    panel.classList.toggle('open', open);
    pill.setAttribute('aria-expanded', String(open));
    if (open && !loadedOnce) {
      loadedOnce = true;
      void loadWhoami();
      void loadAccounts();
    }
  }

  function update(next: Partial<DevMenuState>): void {
    state = { ...state, ...next };
    if (state.hidden) state.open = false;
    writeState(state);
    render();
  }

  pill.addEventListener('click', () => update({ open: !state.open }));
  hideButton.addEventListener('click', () => update({ hidden: true }));
  dot.addEventListener('click', () => {
    update({ hidden: false });
    pill.focus();
  });
  refreshButton.addEventListener('click', () => {
    void loadWhoami();
    void loadAccounts();
  });

  const abort = new AbortController();
  // Hide the whole widget while a modal is open and bring it back when the last one closes. Mutations
  // come in bursts, so the check runs once per frame.
  let modalCheck = 0;
  const checkModal = (): void => {
    modalCheck = 0;
    // A Radix popover also carries role=dialog; it sits in a popper wrapper and is not a modal.
    const open = [...document.querySelectorAll(MODAL_SELECTOR)].some(
      (node) => node.closest('[data-radix-popper-content-wrapper]') === null,
    );
    if (open === modalOpen) return;
    modalOpen = open;
    render();
  };
  const modalObserver = new MutationObserver(() => {
    if (modalCheck === 0) modalCheck = requestAnimationFrame(checkModal);
  });
  modalObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-state', 'open', 'role'],
  });
  checkModal();
  document.addEventListener(
    'keydown',
    (event) => {
      // The chip is out of sight behind a modal, so its keys leave the dialog's Escape alone.
      if (modalOpen) return;
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        update({ hidden: !state.hidden });
        return;
      }
      if (event.key === 'Escape' && state.open && !state.hidden) {
        const hadFocus = shadow.activeElement !== null;
        update({ open: false });
        if (hadFocus) pill.focus();
      }
    },
    { signal: abort.signal },
  );

  render();

  return () => {
    abort.abort();
    modalObserver.disconnect();
    if (modalCheck !== 0) cancelAnimationFrame(modalCheck);
    host.remove();
  };
}

function start(): void {
  const globals = globalThis as Record<symbol, (() => void) | undefined>;
  globals[DISPOSE_KEY]?.();
  globals[DISPOSE_KEY] = mount();
}

/**
 * Mount only after the page has loaded and the browser is idle. Adding a child to <body> while
 * React is still hydrating makes React see an element it did not render and report a hydration
 * mismatch (Next's "1 Issue" badge). Loading first, then idling, lets hydration finish.
 */
function startWhenHydrated(): void {
  const idle = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 1000);
  };
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}

if (typeof document !== 'undefined') startWhenHydrated();
