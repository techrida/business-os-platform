'use client';

import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { forwardRef, useState } from 'react';
import { TextInput, type TextInputProps } from '../input';
import { EyeIcon, EyeOffIcon } from './icons';

export type PasswordFieldProps = Omit<TextInputProps, 'type' | 'suffix'> & {
  /** Accessible name of the toggle while the password is hidden. Defaults to the translated "Show password". */
  showLabel?: string;
  /** Accessible name of the toggle while the password is visible. Defaults to the translated "Hide password". */
  /** Class for the wrapper (the input keeps the shared field styling). */
  wrapperClassName?: string;
};

/**
 * TextInput for passwords with a show/hide toggle. The toggle is a sibling of the label, not inside
 * it, so its name never leaks into the input's accessible name. Props and ref go to the input, so
 * react-hook-form's `register()` works as it does on TextInput.
 */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField({ showLabel, wrapperClassName, disabled, autoComplete, ...props }, ref) {
    const t = useTranslations('bosAuth');
    const [visible, setVisible] = useState(false);

    return (
      <div className={clsx('bos-password-field', wrapperClassName)}>
        <TextInput
          {...props}
          ref={ref}
          disabled={disabled}
          autoComplete={autoComplete ?? 'current-password'}
          type={visible ? 'text' : 'password'}
        />
        <button
          type="button"
          className="bos-password-toggle"
          aria-pressed={visible}
          aria-label={showLabel ?? t('showPassword')}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    );
  },
);
