'use client';

import { type ReactNode, useState } from 'react';

import styles from './brand.module.css';

/**
 * The company logo in the header (R6Q20). It is a plain `<img>` of the same-origin proxy; if the picture cannot be
 * loaded (still being scanned, removed, API down) it is replaced by `fallback`, the text lockup, so the header never
 * shows a broken image. `data-brand-name` lets the collapsed rail hide it like the name.
 */
export function BrandLogo({
  src,
  alt,
  fallback,
}: {
  src: string;
  alt: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a same-origin proxy of a scanned upload; next/image would re-encode it
    <img
      className={styles.logo}
      data-brand-name=""
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
    />
  );
}
