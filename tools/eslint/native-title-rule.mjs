// UIP-BUILD-002: no browser-default hover tooltips in the workspace and portal apps.
// The `title` attribute on a DOM element draws the browser's own bubble, with no keyboard access and a
// long delay. Button and Link pass `title` to the DOM, so they are blocked too. Other components may take
// a `title` prop of their own, and <iframe title> / SVG <title> are accessibility names, not hover hints.
// Shared by eslint.config.mjs and the rule test (apps/workspace/src/components/ui/no-native-title.test.ts).
export const NATIVE_TITLE_RULE = [
  'error',
  {
    selector:
      "JSXOpeningElement[name.type='JSXIdentifier']:matches([name.name=/^[a-z]/], [name.name=/^(Button|Link)$/]):not([name.name=/^(iframe|svg|title)$/]) > JSXAttribute[name.name='title']",
    message:
      'Do not use the native `title` hover hint on a DOM element: the browser draws it in its own style. Wrap the element in <Tooltip content="..."> from "@/components/ui/tooltip" (UIP-BUILD-002). Keep an aria-label for icon-only controls.',
  },
];
