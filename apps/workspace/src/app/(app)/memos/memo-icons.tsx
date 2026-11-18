import type { ReactNode } from 'react';

/**
 * The few drawings the memo screens need that the shared Icon set does not have. Same grid and
 * stroke as the shared icons (24px, 2px round), decorative only: the text beside each one names
 * the action, so they are hidden from assistive technology.
 */
function Drawing({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlusIcon({ size }: { size?: number }) {
  return (
    <Drawing {...(size ? { size } : {})}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Drawing>
  );
}

export function UploadIcon({ size }: { size?: number }) {
  return (
    <Drawing {...(size ? { size } : {})}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </Drawing>
  );
}

export function DownloadIcon({ size }: { size?: number }) {
  return (
    <Drawing {...(size ? { size } : {})}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Drawing>
  );
}

export function PaperclipIcon({ size }: { size?: number }) {
  return (
    <Drawing {...(size ? { size } : {})}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Drawing>
  );
}

export function TrashIcon({ size }: { size?: number }) {
  return (
    <Drawing {...(size ? { size } : {})}>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
    </Drawing>
  );
}

export function PrintIcon({ size }: { size?: number }) {
  return (
    <Drawing {...(size ? { size } : {})}>
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M6 14h12v8H6z" />
    </Drawing>
  );
}
