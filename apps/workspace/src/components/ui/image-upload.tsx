'use client';

// The picture of a record (company logo, profile picture, customer or vendor logo): show it, look at it larger,
// replace it by dropping or choosing a file (the upload starts at once, UIP-FORM-001), and remove it with a
// confirmation (UIP-FORM-002, UIP-FEED-002). Feedback goes through toasts (UIP-FEED-001). After an upload the picture
// is virus-scanned and `GET /api/images/:id` answers 404 until it is clean, so the component shows "Scanning" and
// polls with a backoff until the picture can be served. Once it is, the other avatars of the record on the page are
// told to try again and the caller refreshes a second time.
import type { ImageOwnerType } from '@bos/contracts';
import { IMAGE_ACCEPT, imagePath } from '@bos/contracts/constants';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { announceImageReady, Avatar, type AvatarSize } from './avatar';
import { Button } from './button';
import { ConfirmDialog, Dialog, DialogClose } from './dialog';
import { Icon } from './icon';
import { ImageRefusal, shrinkImage } from './image-resize';
import { scanPollDelays } from './scan-poll';
import { toast } from './toast';
import styles from './image-upload.module.css';

export { scanPollDelays } from './scan-poll';

const UPLOAD_FAILED = 'The picture could not be uploaded. Try again.';
const REMOVE_FAILED = 'The picture could not be removed. Try again.';
const OFFLINE = 'The server could not be reached. Check your connection and try again.';
const SCAN_TIMED_OUT =
  'The picture could not be used yet. If it does not appear soon, upload another.';

/** The `{error:{message}}` of a refused request, or `fallback` when the body is anything else. */
async function refusalMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error;
      if (error && typeof error === 'object' && 'message' in error) {
        const message = error.message;
        if (typeof message === 'string' && message.trim()) return message;
      }
    }
  } catch {
    // Not JSON: use the fallback.
  }
  return fallback;
}

export interface ImageUploadProps {
  ownerType: ImageOwnerType;
  /** The record the picture belongs to (entity, user, customer or vendor id). */
  ownerId: string;
  /** The current picture, or null when the record shows its initials. */
  imageDocumentId: string | null;
  /** The person or company name: initials, alt text and the accessible names of the controls. */
  name: string;
  /** The id the initials colour is picked from (usually `ownerId`). */
  seedId: string | null;
  shape: 'circle' | 'square';
  /** `cover` for profile pictures, `contain` for logos (the whole mark on white). */
  fit: 'cover' | 'contain';
  /** What the picture is, for example "Company logo" or "Profile picture": the group name and the preview title. */
  label: string;
  /**
   * Called with the new document id right after an upload (the picture is still being scanned, so other avatars of
   * the record still show initials), and once more with the same id when the scan watch sees the picture served; or
   * with null after a removal. The second call only comes while this component is mounted and that upload is still
   * the current one (no newer upload or removal since). The caller refreshes its data each time; do not key this
   * component on `imageDocumentId`, or the scanning state is lost when the new id arrives.
   */
  onChange: (documentId: string | null) => void;
  /** Shows the picture and its preview, but nothing can be uploaded or removed. */
  disabled?: boolean | undefined;
  /** Only the picture and its preview: no drop zone, no remove button. */
  readOnly?: boolean | undefined;
  /**
   * The picture's size: `large` (40 px, the default, for settings rows) or `xlarge` (76 px) for the picture at the
   * head of a record's profile card. Initials, preview and scanning state are the same at either size.
   */
  size?: Extract<AvatarSize, 'large' | 'xlarge'> | undefined;
  /**
   * Drawn instead of the initials while there is no picture: a clearly marked example for a slot that has nothing
   * yet (the company logo variants). It must carry its own screen-reader text saying the slot is empty.
   */
  placeholder?: ReactNode;
  /**
   * The colour the picture sits on, for a logo made for one kind of background (a white logo on near-black). It
   * replaces the white behind the picture and in its preview.
   */
  stageBackground?: string | undefined;
}

/**
 * Upload, preview and remove the picture of a record.
 *
 * @example
 *   <ImageUpload
 *     ownerType="user_avatar"
 *     ownerId={user.id}
 *     imageDocumentId={user.avatarDocumentId}
 *     name={user.name}
 *     seedId={user.id}
 *     shape="circle"
 *     fit="cover"
 *     label="Profile picture"
 *     onChange={() => router.refresh()}
 *   />
 */
export function ImageUpload({
  ownerType,
  ownerId,
  imageDocumentId,
  name,
  seedId,
  shape,
  fit,
  label,
  onChange,
  disabled = false,
  readOnly = false,
  size = 'large',
  placeholder,
  stageBackground,
}: ImageUploadProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const hintId = `${ids}-hint`;
  const inputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const [busy, setBusy] = useState(false);
  /** Why the last upload was refused, kept in the field's message line after the toast is gone. */
  const [problem, setProblem] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [over, setOver] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [scanningId, setScanningId] = useState<string | null>(null);
  // Avatar remembers a picture that failed to load (a 404 while scanning) and does not retry it; a new key after the
  // scan gives it a fresh try.
  const [revision, setRevision] = useState(0);

  const stopWatchRef = useRef<(() => void) | null>(null);
  const stopWatch = () => {
    stopWatchRef.current?.();
    stopWatchRef.current = null;
  };
  useEffect(() => () => stopWatchRef.current?.(), []);

  /** Asks for the picture on the backoff schedule until it is served, refused for good, or the budget runs out. */
  const watchScan = (documentId: string) => {
    stopWatch();
    setScanningId(documentId);
    const delays = scanPollDelays();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const finish = (ready: boolean) => {
      stopped = true;
      stopWatchRef.current = null;
      setScanningId(null);
      if (!ready) return;
      setRevision((value) => value + 1);
      // Avatars elsewhere on the page that asked during the scan got a 404 and kept their initials.
      announceImageReady(documentId);
      onChangeRef.current(documentId);
    };
    const check = async (): Promise<'ready' | 'wait' | 'stop'> => {
      try {
        const response = await fetch(imagePath(documentId), {
          cache: 'no-store',
          signal: controller.signal,
        });
        void response.body?.cancel().catch(() => undefined);
        if (response.ok) return 'ready';
        // 404: still scanning. 5xx: the server is having a moment. Anything else (401, 403) will not change.
        return response.status === 404 || response.status >= 500 ? 'wait' : 'stop';
      } catch {
        return 'wait';
      }
    };
    const step = (index: number) => {
      const delay = delays[index];
      if (delay === undefined) {
        // The budget ran out. A refused or infected picture also answers 404, so it may never be served: say so
        // once, instead of quietly showing the initials. A cancelled poll (unmount, new upload, removal) never
        // gets here, since its `stopped` check returns first.
        finish(false);
        toast.error(SCAN_TIMED_OUT);
        return;
      }
      timer = setTimeout(() => {
        void check().then((result) => {
          if (stopped) return;
          if (result === 'wait') step(index + 1);
          else finish(result === 'ready');
        });
      }, delay);
    };

    stopWatchRef.current = () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    };
    step(0);
  };

  const editable = !readOnly && !disabled;

  const upload = async (file: File) => {
    if (!editable || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    const refuse = (message: string) => {
      setProblem(message);
      toast.error(message);
    };
    try {
      let picture: File;
      try {
        picture = await shrinkImage(file);
      } catch (err) {
        refuse(
          err instanceof ImageRefusal
            ? err.message
            : 'This picture could not be read. Try another file.',
        );
        return;
      }
      const body = new FormData();
      body.append('file', picture);
      let response: Response;
      try {
        // No Content-Type header: the browser writes the multipart boundary and the length.
        response = await fetch(`/api/images/${ownerType}/${ownerId}`, { method: 'POST', body });
      } catch {
        refuse(OFFLINE);
        return;
      }
      if (!response.ok) {
        refuse(await refusalMessage(response, UPLOAD_FAILED));
        return;
      }
      let documentId: unknown;
      try {
        documentId = ((await response.json()) as { documentId?: unknown }).documentId;
      } catch {
        documentId = undefined;
      }
      if (typeof documentId !== 'string' || !documentId) {
        refuse(UPLOAD_FAILED);
        return;
      }
      toast.success('Picture uploaded', { description: 'It appears once its virus scan is done.' });
      watchScan(documentId);
      onChangeRef.current(documentId);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const remove = async (): Promise<boolean> => {
    let response: Response;
    try {
      response = await fetch(`/api/images/${ownerType}/${ownerId}`, { method: 'DELETE' });
    } catch {
      toast.error(OFFLINE);
      return false;
    }
    if (!response.ok) {
      toast.error(await refusalMessage(response, REMOVE_FAILED));
      return false;
    }
    stopWatch();
    setScanningId(null);
    setProblem(null);
    toast.success('Picture removed');
    onChangeRef.current(null);
    return true;
  };

  const scanning = scanningId !== null;
  const hasPicture = imageDocumentId !== null;
  const previewable = hasPicture && !scanning;

  const avatar = (
    <Avatar
      key={`${imageDocumentId ?? 'none'}:${revision}`}
      name={name}
      seedId={seedId}
      imageDocumentId={scanning ? null : imageDocumentId}
      size={size}
      shape={shape}
      fit={fit}
      {...(stageBackground
        ? {
            style: {
              '--avatar-image-bg': stageBackground,
              '--avatar-fill': stageBackground,
            } as CSSProperties,
          }
        : {})}
    />
  );
  const shown = !hasPicture && placeholder ? placeholder : avatar;

  const picture: ReactNode = previewable ? (
    <Dialog
      open={previewOpen}
      onOpenChange={setPreviewOpen}
      trigger={
        <button
          type="button"
          className={styles.picture}
          data-shape={shape}
          aria-label={`View ${name} picture`}
        >
          {avatar}
          <BusyVeil busy={busy} />
        </button>
      }
      title={label}
      description={name}
      size="medium"
      footer={
        <>
          {editable ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                // Open the file chooser inside this click (browsers allow it only in a user gesture), then close.
                inputRef.current?.click();
                setPreviewOpen(false);
              }}
            >
              Replace
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </>
      }
    >
      <PreviewStage documentId={imageDocumentId} name={name} background={stageBackground} />
    </Dialog>
  ) : (
    <span className={styles.picture} data-shape={shape} data-static="true">
      {shown}
      <BusyVeil busy={busy} />
    </span>
  );

  return (
    <div
      className={styles.root}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      data-readonly={readOnly ? 'true' : undefined}
    >
      <div className={styles.pictureColumn}>
        {picture}
        <span role="status" className={styles.status}>
          {scanning ? (
            <span className={styles.scanning}>
              <Icon name="shield-check" size={14} />
              Scanning
            </span>
          ) : null}
          {busy ? <span className="sr-only">Uploading</span> : null}
        </span>
      </div>

      {readOnly ? null : (
        <label
          className={styles.drop}
          data-over={over ? 'true' : undefined}
          data-busy={busy ? 'true' : undefined}
          data-disabled={disabled ? 'true' : undefined}
          onDragOver={(event) => {
            if (!editable) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            if (!editable) return;
            event.preventDefault();
            setOver(false);
            const file = event.dataTransfer.files[0];
            if (file) void upload(file);
          }}
        >
          {/* Not disabled while busy: focus would fall to the page. A pick during an upload is ignored instead. */}
          <input
            ref={inputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            className="sr-only"
            disabled={disabled}
            aria-labelledby={titleId}
            aria-describedby={hintId}
            onClick={(event) => {
              // The chooser stays shut during an upload, rather than opening for a pick that would be ignored.
              if (busyRef.current) event.preventDefault();
            }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void upload(file);
            }}
          />
          <span className={styles.dropIcon} aria-hidden="true">
            {busy ? <SpinnerGlyph /> : <UploadGlyph />}
          </span>
          <span className={styles.dropText}>
            <span id={titleId} className={styles.dropTitle}>
              {hasPicture ? 'Replace picture' : 'Upload picture'}
            </span>
            <span id={hintId} className={styles.dropHint}>
              <span className={styles.dropHow}>Drop a file here or choose one.</span>
            </span>
          </span>
        </label>
      )}

      {editable && hasPicture ? (
        <ConfirmDialog
          trigger={
            <Button
              variant="ghost"
              size="small"
              className={styles.remove}
              disabled={busy}
              aria-label={`Remove ${name} picture`}
            >
              <Icon name="x" size={16} />
            </Button>
          }
          title={`Remove the picture of ${name}?`}
          description="Initials show in its place until a new picture is uploaded."
          confirmLabel="Remove picture"
          destructive
          onConfirm={remove}
        />
      ) : null}

      {problem ? (
        <p role="status" className={styles.problem}>
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The large picture in the preview dialog, whole and in its own proportions. */
function PreviewStage({
  documentId,
  name,
  background,
}: {
  documentId: string | null;
  name: string;
  background?: string | undefined;
}) {
  const src = documentId ? imagePath(documentId) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <div className={styles.stage} style={background ? { background } : undefined}>
      {src && failedSrc !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- same-origin proxied picture; next/image adds nothing here
        <img
          className={styles.stageImage}
          src={src}
          alt={`${name} picture`}
          decoding="async"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <p className={styles.stageFallback}>This picture cannot be shown right now.</p>
      )}
    </div>
  );
}

function BusyVeil({ busy }: { busy: boolean }) {
  if (!busy) return null;
  return (
    <span className={styles.veil} aria-hidden="true">
      <SpinnerGlyph />
    </span>
  );
}

// Two Lucide drawings (upload, loader-circle) not yet in the shared Icon set; same 24 grid and 2px round stroke.
function Glyph({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <svg
      className={className}
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function UploadGlyph() {
  return (
    <Glyph>
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </Glyph>
  );
}

function SpinnerGlyph() {
  return (
    <Glyph className={styles.spinner}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </Glyph>
  );
}
