'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import styles from './field.module.css';

/** What a control inside a `Field` can hand to the field's one message line (UIP-FORM-010). */
interface FieldScopeValue {
  /** The id of the Field's own control: only that control may use the message line. */
  controlId: string;
  setSecondary: (text: ReactNode) => void;
}

const FieldScopeContext = createContext<FieldScopeValue | null>(null);

/**
 * True for the control a `Field` handed its id to: it then reports a secondary value (the BS date) or places its
 * refusal in the field's message line instead of printing its own. Any other control inside the Field (the rows of a
 * phone list) keeps its own layout.
 */
export function useInFieldScope(controlId: string | undefined): boolean {
  const scope = useContext(FieldScopeContext);
  return scope !== null && controlId !== undefined && scope.controlId === controlId;
}

/**
 * Reports a secondary value for the field's message line, for as long as the control is mounted. It shows after
 * the field's error is gone and before its hint, in the same line, so the line never grows or moves the box.
 */
export function useFieldSecondary(controlId: string | undefined, text: ReactNode): void {
  const scope = useContext(FieldScopeContext);
  const setSecondary =
    scope !== null && scope.controlId === controlId ? scope.setSecondary : undefined;
  useEffect(() => {
    if (!setSecondary) return;
    setSecondary(text);
    return () => setSecondary(null);
  }, [setSecondary, text]);
}

/**
 * The part of `Field` that has state: provides the scope and renders the ONE reserved message line below the box.
 * An error replaces the hint and the secondary value; otherwise the secondary value and the hint share the line.
 * The line is present (one line high) even when empty, so showing or clearing an error moves nothing.
 */
export function FieldScope({
  children,
  hint,
  error,
  hintId,
  errorId,
  controlId,
}: {
  children: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  hintId: string;
  errorId: string;
  controlId: string;
}) {
  const [secondary, setSecondary] = useState<ReactNode>(null);
  const showError = Boolean(error);
  const parts = showError ? null : [secondary, hint].filter(Boolean);
  const content = showError ? error : parts && parts.length > 0 ? parts : null;
  return (
    <FieldScopeContext.Provider value={{ controlId, setSecondary }}>
      {children}
      <span
        id={showError ? errorId : hintId}
        className={showError ? styles.error : styles.message}
        data-message=""
      >
        {showError ? (
          error
        ) : content ? (
          <>
            {secondary}
            {secondary && hint ? ' · ' : null}
            {hint}
          </>
        ) : null}
      </span>
    </FieldScopeContext.Provider>
  );
}
