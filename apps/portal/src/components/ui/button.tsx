import Link from 'next/link';
import type { AnchorHTMLAttributes, ComponentProps, ButtonHTMLAttributes } from 'react';

import styles from './button.module.css';
import { linkKind } from './link-kind';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'small' | 'medium' | 'large';

interface Look {
  variant?: Variant | undefined;
  size?: Size | undefined;
}

function classes({ variant = 'primary', size = 'medium' }: Look, extra?: string): string {
  return [styles.button, styles[variant], styles[size], extra].filter(Boolean).join(' ');
}

/** Figma Button: Primary / Secondary / Ghost, Small 36 / Medium 40 / Large 48. */
export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & Look) {
  return <button type={type} className={classes({ variant, size }, className)} {...rest} />;
}

type LinkRest = Omit<ComponentProps<typeof Link>, 'href' | 'className' | 'prefetch'>;

/**
 * A link that looks like a button. An internal page path goes through `next/link` without a
 * prefetch (the targets are dynamic pages, so a prefetch only costs a request). Route-handler
 * targets (/auth/login, PDFs, exports), downloads, new-tab and external links stay plain anchors,
 * because the router would fetch a handler twice and a prefetch of /auth/login would start a login.
 * `native` forces the plain anchor.
 */
export function LinkButton({
  variant,
  size,
  className,
  native,
  href,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> &
  Look & { href: string; native?: boolean }) {
  const cls = classes({ variant, size }, className);
  if (linkKind({ href, download: rest.download, target: rest.target, native }) === 'router') {
    // Anchor props are a subset of Link's; exactOptionalPropertyTypes only objects to the `undefined`s.
    return <Link href={href} prefetch={false} className={cls} {...(rest as LinkRest)} />;
  }
  return <a href={href} className={cls} {...rest} />;
}
