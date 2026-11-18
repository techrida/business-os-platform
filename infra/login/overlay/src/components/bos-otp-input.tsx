'use client';

import { OTPInput, REGEXP_ONLY_DIGITS } from 'input-otp';
import { useId } from 'react';
import type { ControllerRenderProps } from 'react-hook-form';

export const AUTHENTICATOR_CODE = /^[0-9]{6}$/;

export function AuthenticatorCode({
  field,
  label,
  hint,
  errorId,
  readOnly,
  onComplete,
  onEdit,
}: {
  field: ControllerRenderProps<{ code: string }, 'code'>;
  label: string;
  hint: string;
  errorId?: string;
  readOnly: boolean;
  onComplete: () => void;
  onEdit: () => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <>
      <label className="bos-otp-label block" htmlFor={id}>
        {label}
      </label>
      <OTPInput
        {...field}
        id={id}
        dir="ltr"
        autoFocus
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        pasteTransformer={(pasted) =>
          // Last standalone six-digit run; no lookbehind, so older Safari can parse the chunk.
          (pasted.match(/[0-9]+/g) ?? []).filter((run) => run.length === 6).pop() ??
          pasted.replace(/[^0-9]/g, '')
        }
        readOnly={readOnly}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId ? `${hintId} ${errorId}` : hintId}
        data-testid="code-text-input"
        onChange={(value) => {
          if (readOnly) return;
          field.onChange(value);
          onEdit();
        }}
        onComplete={onComplete}
        render={({ slots }) => (
          <div
            className="bos-otp-slots"
            dir="ltr"
            aria-hidden="true"
            data-invalid={errorId ? '' : undefined}
          >
            {slots.map(({ char, isActive, hasFakeCaret }, index) => (
              <span
                key={index}
                className="bos-otp-slot"
                data-active={!readOnly && isActive ? '' : undefined}
                data-caret={!readOnly && hasFakeCaret ? '' : undefined}
              >
                {char}
              </span>
            ))}
          </div>
        )}
      />
      <p id={hintId} className="bos-otp-hint">
        {hint}
      </p>
    </>
  );
}
