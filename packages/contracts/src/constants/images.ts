// Constants and pure helpers the signed-in shell loads in every page. This module must not import zod (or
// anything heavy): the root of @bos/contracts is a large schema bundle, and a client component that took one
// value from it would pull the whole bundle into every route. Server code keeps importing from the root, which
// re-exports everything here.

/** PNG, JPEG and WebP only. SVG is never accepted: it can carry script and is never inlined. */
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIME)[number];

/** 512 KiB. The upload screen shrinks and re-encodes every picture until it fits, so this is only the safety net. */
export const IMAGE_MAX_BYTES = 524_288;
/** The longest side the upload screen shrinks a picture to before it is sent. */
export const IMAGE_MAX_SIDE_PX = 512;

export const IMAGE_ACCEPT = IMAGE_MIME.join(',');

// ---------------------------------------------------------------------------------------------
// Initials and colour: what a record shows until (or instead of) a picture
// ---------------------------------------------------------------------------------------------

/**
 * Twelve backgrounds, each with white text at 4.5:1 or better (checked by the test). The colour of a person or company
 * is one of these, picked from its id, so the same record has the same colour on every screen and in every app.
 */
export const AVATAR_PALETTE = [
  '#1d4ed8',
  '#0f766e',
  '#15803d',
  '#b45309',
  '#be123c',
  '#6d28d9',
  '#0e7490',
  '#a21caf',
  '#4d7c0f',
  '#c2410c',
  '#4338ca',
  '#475569',
] as const;

/** FNV-1a, 32 bit: tiny, stable across runtimes, and spreads UUIDs well enough for twelve buckets. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The colour for a record id. Same id, same colour, always; no id (an unsaved record) gets the neutral slate. */
export function avatarColour(seedId: string | null | undefined): string {
  if (!seedId) return AVATAR_PALETTE[AVATAR_PALETTE.length - 1]!;
  return AVATAR_PALETTE[fnv1a(seedId.toLowerCase()) % AVATAR_PALETTE.length]!;
}

/** Up to two initials from a name (first letters of the first two words), or "?" when there is no usable letter. */
export function avatarInitials(name: string): string {
  const words = name
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase())
    .join('');
  return initials || '?';
}

/** Path of the same-origin image route the workspace serves (the API route is `/v1/images/:documentId`). */
export function imagePath(documentId: string): string {
  return `/api/images/${documentId}`;
}
