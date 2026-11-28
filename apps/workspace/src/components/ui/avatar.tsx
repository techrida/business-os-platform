'use client';

// A client component only because the picture needs an error fallback (state). It still renders on the server first,
// so the initials are in the HTML before any script runs; the picture sits above them once it loads.
import { avatarColour, avatarInitials, imagePath } from '@bos/contracts/constants';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from 'react';

import styles from './avatar.module.css';
import { scanPollDelays } from './scan-poll';

type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  name: string;
  /** The record id the background colour is picked from; the same id gets the same colour everywhere. */
  seedId?: string | null;
  /** The current image document; its picture covers the initials once it loads. */
  imageDocumentId?: string | null;
  /** 24, 32 and 40 px; `xlarge` (76 px) is the picture at the head of a record's profile card. */
  size?: AvatarSize;
  shape?: 'square' | 'circle';
  /** `cover` fills the shape (profile pictures); `contain` fits a logo whole on white with a hairline border. */
  fit?: 'cover' | 'contain';
};

export type AvatarSize = 'small' | 'medium' | 'large' | 'xlarge';

const IMAGE_READY_EVENT = 'bos:image-ready';

/**
 * Tells every avatar on the page that this picture can now be served. A new picture answers 404 until its virus scan
 * is done; an avatar that asked during the scan keeps its initials and asks again on a backoff, and this gives it a
 * fresh try at once (or after it gave up). ImageUpload calls it when its scan watch sees the picture served.
 */
export function announceImageReady(documentId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<string>(IMAGE_READY_EVENT, { detail: imagePath(documentId) }),
  );
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
      {imageDocumentId ? (
        <AvatarImage key={imageDocumentId} src={imagePath(imageDocumentId)} fit={fit} />
      ) : null}
    </span>
  );
}

/**
 * Where one picture's load stands. A new picture answers 404 until its virus scan is done, so a failed picture asks
 * again on its own after the scan-poll waits (1, 2, 4, 8, 15, 15, 15 s); that also covers the avatar beside a dialog
 * that was closed mid-scan, whose ImageUpload is gone and can no longer announce the picture.
 */
type PictureLoad = {
  /** The `<img>` key: bumped for every fresh try, so each try is a new element that requests the picture again. */
  attempt: number;
  /** Errors since the last fresh start; the n-th error waits the n-th delay, and past the last one it gives up. */
  errors: number;
  /** No image is drawn: a retry is waiting, or the waits are used up and the initials stay. */
  failed: boolean;
  /** This try's picture arrived. Until then a retry stays transparent, so its pending box never covers the initials. */
  loaded: boolean;
};

const FIRST_LOAD: PictureLoad = { attempt: 0, errors: 0, failed: false, loaded: false };

/** Keyed by the picture's path, so a new picture starts from a first try with no timer left over. */
function AvatarImage({ src, fit }: { src: string; fit: 'cover' | 'contain' }) {
  const ref = useRef<HTMLImageElement>(null);
  const [load, setLoad] = useState<PictureLoad>(FIRST_LOAD);
  const { failed, errors } = load;

  // One failure path for both error sources; a second report of the same try is ignored, so it spends one wait.
  const fail = useCallback(
    () =>
      setLoad((prev) => (prev.failed ? prev : { ...prev, errors: prev.errors + 1, failed: true })),
    [],
  );

  // An error that fires before hydration attaches onError is lost; a finished image with no pixels is that case.
  useEffect(() => {
    const image = ref.current;
    if (image?.complete && image.naturalWidth === 0) fail();
  }, [fail]);

  // After a failure, wait the next delay and mount a fresh image. A re-render does not restart the wait.
  useEffect(() => {
    if (!failed) return;
    const delay = scanPollDelays()[errors - 1];
    if (delay === undefined) return;
    const timer = window.setTimeout(
      () =>
        setLoad((prev) => ({ ...prev, attempt: prev.attempt + 1, failed: false, loaded: false })),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [failed, errors]);

  // Word that this picture passed its scan: try again now, with the waits starting over.
  useEffect(() => {
    if (!failed) return;
    const retry = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === src) {
        setLoad((prev) => ({ attempt: prev.attempt + 1, errors: 0, failed: false, loaded: false }));
      }
    };
    window.addEventListener(IMAGE_READY_EVENT, retry);
    return () => window.removeEventListener(IMAGE_READY_EVENT, retry);
  }, [failed, src]);

  if (failed) return null;
  // The first try draws as it always has; a retry shows only once its picture is there (opacity, so lazy still fetches).
  const hidden = load.attempt > 0 && !load.loaded;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a same-origin, authenticated picture route: drawn through <img> only
    <img
      key={load.attempt}
      ref={ref}
      className={[styles.image, fit === 'contain' ? styles.contain : null]
        .filter(Boolean)
        .join(' ')}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      style={hidden ? { opacity: 0 } : undefined}
      onLoad={() => setLoad((prev) => (prev.loaded ? prev : { ...prev, loaded: true }))}
      onError={fail}
    />
  );
}
