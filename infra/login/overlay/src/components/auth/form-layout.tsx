import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';

/** Vertical stack of fields, 20px apart (the Figma form gap). */
export function FormStack({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('bos-form-stack', className)} {...props} />;
}

/** Right-aligned line directly under a field, for example the "Forgot Password?" link. */
export function FieldAside({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('bos-field-aside', className)} {...props} />;
}

/** Centered line under the primary button: "Don't have an account? <link>". */
export function SwitchLine({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={clsx('bos-switch-line', className)}>{children}</p>;
}
