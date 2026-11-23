// UIP-BUILD-002: no browser-default hover tooltips in the workspace and portal apps.
// The `title` attribute on a DOM element draws the browser's own bubble, with no keyboard access and a
// long delay. Button, LinkButton, Link and Badge pass `title` to the DOM, so they are blocked too. Other components may take
// a `title` prop of their own, and <iframe title> / SVG <title> are accessibility names, `<input title>` is the validation message and `<abbr title>` the expansion: none is a hover hint.
// Shared by eslint.config.mjs and the rule test (apps/workspace/src/components/ui/no-native-title.test.ts).
export const NATIVE_TITLE_RULE = [
  'error',
  {
    selector:
      "JSXOpeningElement[name.type='JSXIdentifier']:matches([name.name=/^[a-z]/], [name.name=/^(Button|LinkButton|Link|Badge)$/]):not([name.name=/^(iframe|svg|title|input|abbr)$/]) > JSXAttribute[name.name='title']",
    message:
      'Do not use the native `title` hover hint on a DOM element: the browser draws it in its own style. Wrap the element in <Tooltip content="..."> from "@/components/ui/tooltip" (UIP-BUILD-002). Keep an aria-label for icon-only controls.',
  },
];

// UIP-FORM-011: buttons in a page header or action bar carry no description text; the explanation goes in
// the Tooltip. Two shapes are caught: a <p>/<small> inside an `actions` prop (header action slot), and a
// blocked button wired to a caption with `aria-disabled` + `aria-describedby` (the old "reason under the
// button" pattern). A page-level status belongs in a page alert instead.
export const NO_ACTION_CAPTION_SELECTORS = [
  {
    selector:
      "JSXAttribute[name.name='actions'] JSXElement[openingElement.name.name=/^(p|small)$/]",
    message:
      'No description text beside header or action-bar buttons (UIP-FORM-011). Put the explanation in <Tooltip content="..."> around the button; page-level status goes in a page alert.',
  },
  {
    selector:
      "JSXOpeningElement[name.name=/^(Button|button|LinkButton)$/]:has(JSXAttribute[name.name='aria-disabled']):has(JSXAttribute[name.name='aria-describedby'])",
    message:
      'A blocked action button must not point at a caption under it (UIP-FORM-011). Wrap it in <Tooltip content="reason"> and keep it aria-disabled so it stays focusable.',
  },
];

/** The whole `no-restricted-syntax` entry the workspace and portal apps use. */
export const RESTRICTED_SYNTAX = ['error', NATIVE_TITLE_RULE[1], ...NO_ACTION_CAPTION_SELECTORS];
