import type { AnchorHTMLAttributes } from 'react';

/** Stands in for `next/link` in the browser harness: a plain anchor. */
export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} />;
}
