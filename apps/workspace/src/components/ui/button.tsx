import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from 'react';

import styles from './button.module.css';

type Variant = 'primary' | 'secondary' | 'tertiary' | 'ghost';
type Size = 'small' | 'medium' | 'large';

interface Look {
  variant?: Variant | undefined;
  size?: Size | undefined;
}

function classes({ variant = 'primary', size = 'medium' }: Look, extra?: string): string {
  return [styles.button, styles[variant], styles[size], extra].filter(Boolean).join(' ');
}

/** Figma Button: Primary / Secondary / Tertiary / Ghost, Small 34 / Medium 40 / Large 48. */
export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & Look & { ref?: Ref<HTMLButtonElement> }) {
  return <button type={type} className={classes({ variant, size }, className)} {...rest} />;
}

/**
 * A link that looks like a button. It is a plain anchor, never next/link: several targets
 * (/auth/login) are route handlers, and a prefetch of one would start a login.
 */
export function LinkButton({
  variant,
  size,
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & Look) {
  return <a className={classes({ variant, size }, className)} {...rest} />;
}
