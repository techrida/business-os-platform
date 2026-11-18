# UI feedback: toasts, the bell and inline messages

Three channels tell people something happened. Pick by how long the information must stay available.

| Channel                                        | What it is                              | Use it for                                                                                                                                         | Do not use it for                                                                                   |
| ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Toast** (`toast`, `components/ui/toast.tsx`) | Transient, in-app, disappears by itself | Confirming an action just taken: "File downloaded", "Moved to Contacted", "Link copied". A failed action with no field to blame: "Could not save". | Anything the user must find later, anything needing a decision, anything that blocks the next step. |
| **Bell** (`notifications-bell.tsx`)            | Persistent inbox, polled, unread count  | Business events for someone: "Memo waiting for your approval", "Your request was rejected". Survives reloads and logout, links to the work.        | Feedback on the user's own click.                                                                   |
| **Inline** (`Alert`, field error text)         | Stays on the page next to the cause     | Validation errors on fields, a page that cannot load, a state that stays true ("This memo is locked").                                             | A one-off confirmation (use a toast). Never leave "Saved" text beside a button.                     |

Rule of thumb: if the user will ask "where did that go?", it is a notification or inline, not a toast.

## Using toasts

`<WorkspaceToaster />` is mounted once in `app/layout.tsx`. Call `toast` from client code only (event handlers, callbacks); it does nothing on the server, so return the result from a server action and toast where it is received.

```tsx
import { toast } from '@/components/ui/toast';

toast.success('File downloaded');
toast.error('Could not save', { description: 'The memo is locked.' });
toast.info('Moved to Contacted', { action: { label: 'Undo', onClick: undo } });
toast.success('Saved', { id: 'memo-autosave' }); // same id updates in place instead of stacking
toast.dismiss(id); // or toast.dismiss() for all
```

Tones: `info` (default `toast(...)`), `success`, `warning`, `error`. Options: `description`, `duration`, `id`, `action` (one follow-up button). Titles are short, sentence case, no full stop. Statuses stay one or two words elsewhere; a toast title is a short sentence at most.

## Behaviour

- Top right, below the header, stacked newest first; up to 4 visible, the rest queue. Hover or focus expands the stack and pauses timers. Swipe right or press the x to dismiss. Alt+T moves focus into the stack.
- Duration: 4 s, 5 s with an action, 8 s for errors (people need longer to read what went wrong). Override with `duration`; `Infinity` keeps it until dismissed, use sparingly.
- Accessibility: the stack is a region labelled "Notifications"; each toast is a polite live region, and errors also carry `role="alert"`. The tone is carried by the icon shape, the label text and the start edge, not by colour alone. Reduced motion: the global `prefers-reduced-motion` rule removes the slide/stack transition; toasts still appear and time out.
- Mobile: full width minus 12 px gutters (plus safe-area insets), under the header.
- Known limit: while a modal dialog is open, assistive technology treats everything outside it as hidden, so a toast raised from inside a dialog may not be announced. Show errors inside the dialog (inline) and toast after it closes.

## Design and tokens

Built on Sonner (headless `toast.custom`, which keeps its stacking, timers and swipe). The card matches the bell panel and `Alert`: elevated surface, thin border, `--radius-xl`, status-coloured icon, primary text colour. Tokens in `styles/tokens.css`: `--toast-bg`, `--toast-border`, `--toast-text`, `--toast-shadow`, `--toast-width`. The filled `--toast-<tone>-bg/-text` tokens from the Figma export are kept but unused by the card: white text on the 600-level status colours is acceptable, but a tinted-icon card matches the bell and alerts, and stacked solid colour blocks are loud. Figma has no toast frame matching this yet.

Package: `sonner` 2.0.8 (workspace catalog), client-only.
