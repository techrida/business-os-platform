'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';

import styles from './field.module.css';

interface Blocker {
  key: string;
  text: ReactNode;
  rank: number;
}

/** What a control inside a `Field` can hand to the field's one message line (UIP-FORM-010). */
interface FieldScopeValue {
  /** The id of the Field's own control: only that control may use the message line. */
  controlId: string;
  setSecondary: (text: ReactNode) => void;
  setBlocker: (key: string, text: ReactNode, rank: number) => void;
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
 *
 * There is ONE slot, on purpose: a Field wraps one control, and only the control that carries the field's id may
 * write to it. Today that is the date picker's BS date and the amount in words of a money input; neither field
 * needs a second value. A control with two supplementary texts joins them into one `text` itself instead of asking
 * for a second slot, because a second line would move the box (UIP-FORM-010).
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
 * Reports a refusal the control itself raised ("Finish the date") as the field's message, for as long as `text` is
 * set. It takes the line from the field's own error and hint, so it is the only message under the box. Several
 * reporters in one field (the date and time of a date-time picker) still show one message: the highest `rank` wins,
 * the later one on a tie.
 */
export function useFieldBlocker(controlId: string | undefined, text: ReactNode, rank = 0): void {
  const scope = useContext(FieldScopeContext);
  const key = useId();
  const setBlocker = scope !== null && scope.controlId === controlId ? scope.setBlocker : undefined;
  useEffect(() => {
    if (!setBlocker || !text) return;
    setBlocker(key, text, rank);
    return () => setBlocker(key, null, rank);
  }, [setBlocker, key, text, rank]);
}

/**
 * The part of `Field` that has state: provides the scope and renders the ONE reserved message line below the box.
 * A control's own refusal replaces the error, an error replaces the hint and the secondary value; otherwise the
 * secondary value and the hint share the line. The line is present (one line high) even when empty, so showing or
 * clearing an error moves nothing.
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
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const setBlocker = useCallback(
    (key: string, text: ReactNode, rank: number) =>
      setBlockers((all) => {
        const rest = all.filter((b) => b.key !== key);
        return text ? [...rest, { key, text, rank }] : rest;
      }),
    [],
  );
  const blocker = blockers.reduce<Blocker | null>(
    (best, b) => (best === null || b.rank >= best.rank ? b : best),
    null,
  );
  const showError = Boolean(error);
  const loud = showError || blocker !== null;
  return (
    <FieldScopeContext.Provider value={{ controlId, setSecondary, setBlocker }}>
      {children}
      <span
        id={showError ? errorId : hintId}
        className={loud ? styles.error : styles.message}
        data-message=""
      >
        {blocker !== null ? (
          <span role="alert">{blocker.text}</span>
        ) : showError ? (
          error
        ) : secondary || hint ? (
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
