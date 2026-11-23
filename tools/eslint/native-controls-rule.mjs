// UIP-BUILD-002: no browser-default controls in the workspace and portal apps.
// A bare `<input type="checkbox|radio">` draws the browser's own tick box or dot: use `Checkbox`, or
// `RadioGroup` + `Radio` ("@/components/ui/checkbox"). `window.confirm|alert|prompt` open the browser's
// own modal: use `ConfirmDialog` ("@/components/ui/dialog") or a toast. The first is a
// `no-restricted-syntax` selector, the second is ESLint's core `no-alert` (it follows scope, so a local
// function named `confirm` is fine).
// Shared by eslint.config.mjs and the rule test (apps/workspace/src/components/ui/no-native-controls.test.ts).
export const NATIVE_INPUT_SELECTOR = {
  // type="checkbox" or type={'radio'}: the two literal spellings.
  selector:
    "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type']:matches([value.value=/^(checkbox|radio)$/], [value.expression.value=/^(checkbox|radio)$/])",
  message:
    'Do not use a bare <input type="checkbox|radio">: the browser draws it in its own style. Use <Checkbox> or <RadioGroup> + <Radio> from "@/components/ui/checkbox" (UIP-BUILD-002).',
};

export const NO_NATIVE_DIALOGS = 'error';
