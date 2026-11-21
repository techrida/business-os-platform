import { useEffect, useInsertionEffect, useRef, type RefObject } from 'react';

/**
 * React Aria resets its hidden field when the form resets, and a controlled field then reports
 * that as a change; a native controlled control never does. React 19 resets forms after every
 * function action, so that report would undo the user's choice. This calls `onReset` instead
 * and tells `isResetting()` to swallow the changes React Aria emits during the reset.
 */
export function useFormReset(root: RefObject<Element | null>, onReset: () => void) {
  const resetting = useRef(false);
  const latest = useRef(onReset);
  // React 19 resets the form at the end of the commit that follows a function action, after the
  // insertion effects and before the others. Updated here, the callback a reset runs is the one from
  // that commit's render, so it restores the default the action has just saved, not the old one.
  useInsertionEffect(() => {
    latest.current = onReset;
  });
  useEffect(() => {
    const form = root.current?.closest('form');
    if (!form) return;
    const listener = () => {
      resetting.current = true;
      latest.current();
      setTimeout(() => {
        resetting.current = false;
      }, 0);
    };
    // Capture phase: runs before React Aria's own listener on the same form.
    form.addEventListener('reset', listener, true);
    return () => form.removeEventListener('reset', listener, true);
  }, [root]);
  return () => resetting.current;
}
