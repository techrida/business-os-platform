'use client';

// A client component only because the picture needs an error fallback (state). It still renders on the server first,
// so the initials are in the HTML before any script runs; the picture sits above them once it loads.
import { avatarColour, avatarInitials, imagePath } from '@bos/contracts';
import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';

import styles from './avatar.module.css';

type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  name: string;
  /** The record id the background colour is picked from; the same id gets the same colour everywhere. */
  seedId?: string | null;
  /** The current image document; its picture covers the initials once it loads. */
  imageDocumentId?: string | null;
  size?: 'small' | 'medium' | 'large';
  shape?: 'square' | 'circle';
  /** `cover` fills the shape (profile pictures); `contain` fits a logo whole on white with a hairline border. */
  fit?: 'cover' | 'contain';
};

const IMAGE_READY_EVENT = 'bos:image-ready';

/**
 * Tells every avatar on the page that this picture can now be served. A new picture answers 404 until its virus scan
 * is done, and an avatar that asked during the scan keeps its initials (a refresh with the same id does not retry);
 * this gives those avatars a fresh try. ImageUpload calls it when its scan watch sees the picture served.
 */
export function announceImageReady(documentId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(IMAGE_READY_EVENT, { detail: imagePath(documentId) }));
}

/** A picture or initials avatar for use alongside the person's or company's name. Decorative: the name is beside it. */
export function Avatar({
  name,
  seedId,
  imageDocumentId,
  size = 'medium',
  shape = 'square',
  fit = 'cover',
  className,
  style,
  ...rest
}: AvatarProps) {
  return (
    <span
      className={[styles.avatar, styles[size], styles[shape], className].filter(Boolean).join(' ')}
      style={{ '--avatar-fill': avatarColour(seedId), ...style } as CSSProperties}
      aria-hidden="true"
      {...rest}
    >
      {avatarInitials(name)}
      {imageDocumentId ? <AvatarImage src={imagePath(imageDocumentId)} fit={fit} /> : null}
    </span>
  );
}

function AvatarImage({ src, fit }: { src: string; fit: 'cover' | 'contain' }) {
  const ref = useRef<HTMLImageElement>(null);
  // Remember which src failed, so a new picture gets a fresh try without a reset effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // An error that fires before hydration attaches onError is lost; a finished image with no pixels is that case.
  useEffect(() => {
    const image = ref.current;
    if (image?.complete && image.naturalWidth === 0) setFailedSrc(src);
  }, [src]);

  // A failed picture waits for word that it passed its scan, then mounts a fresh image that asks again.
  const failed = failedSrc === src;
  useEffect(() => {
    if (!failed) return;
    const retry = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === src) setFailedSrc(null);
    };
    window.addEventListener(IMAGE_READY_EVENT, retry);
    return () => window.removeEventListener(IMAGE_READY_EVENT, retry);
  }, [failed, src]);

  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a same-origin, authenticated picture route: drawn through <img> only
    <img
      ref={ref}
      className={[styles.image, fit === 'contain' ? styles.contain : null]
        .filter(Boolean)
        .join(' ')}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
    />
  );
}
