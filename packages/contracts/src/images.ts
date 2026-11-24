// Pictures that belong to a record: the company logo, a user's profile picture, a customer's or vendor's logo.
// They travel through the documents pipeline (upload, type check, virus scan, tenant-scoped storage) as documents of
// the owner types below, so this file holds only what the pipeline and the screens must agree on.
import { z } from 'zod';

/** The owner types of image documents (`documents.owner_type`). */
export const IMAGE_OWNER_TYPES = [
  'entity_logo',
  'entity_logo_on_dark',
  'entity_logo_on_light',
  'user_avatar',
  'customer_logo',
  'vendor_logo',
] as const;
export const ImageOwnerTypeSchema = z.enum(IMAGE_OWNER_TYPES);
export type ImageOwnerType = z.infer<typeof ImageOwnerTypeSchema>;

/**
 * The company logo comes in three slots (R6AC): the primary, one for dark backgrounds (also called the reversed or
 * light logo) and one for light backgrounds (the dark logo). Each is an image owner type and a pointer in the
 * `entity.profile` setting; the two variants are optional.
 */
export const ENTITY_LOGO_OWNER_TYPES = [
  'entity_logo',
  'entity_logo_on_dark',
  'entity_logo_on_light',
] as const;
export type EntityLogoOwnerType = (typeof ENTITY_LOGO_OWNER_TYPES)[number];

export function isEntityLogoOwnerType(value: string): value is EntityLogoOwnerType {
  return (ENTITY_LOGO_OWNER_TYPES as readonly string[]).includes(value);
}

/** The `entity.profile` field that names each slot's current image. */
export const ENTITY_LOGO_FIELD = {
  entity_logo: 'logoDocumentId',
  entity_logo_on_dark: 'logoOnDarkDocumentId',
  entity_logo_on_light: 'logoOnLightDocumentId',
} as const satisfies Record<EntityLogoOwnerType, string>;

export function isImageOwnerType(value: string): value is ImageOwnerType {
  return (IMAGE_OWNER_TYPES as readonly string[]).includes(value);
}

/** PNG, JPEG and WebP only. SVG is never accepted: it can carry script and is never inlined. */
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIME)[number];

/** 512 KiB. The upload screen shrinks and re-encodes every picture until it fits, so this is only the safety net. */
export const IMAGE_MAX_BYTES = 524_288;
/** The longest side the upload screen shrinks a picture to before it is sent. */
export const IMAGE_MAX_SIDE_PX = 512;

export const IMAGE_ACCEPT = IMAGE_MIME.join(',');

/** Body of `PUT /v1/images/:ownerType/:ownerId`: make a (clean or still scanning) uploaded image current, or null to remove. */
export const SetImageBodySchema = z.strictObject({ documentId: z.guid().nullable() });
export type SetImageBody = z.infer<typeof SetImageBodySchema>;

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

/**
 * The company's face for a screen or an email (R6Q20): the display name from `entity.profile` and the current primary
 * logo as the pair its public read route takes (`/v1/public/logo/:tenantId/:documentId`; the web apps proxy it as
 * `/brand/logo/:tenantId/:documentId`). Either may be null: no name or no logo set. Read by any signed-in principal
 * (staff, customer, vendor) with `GET /v1/branding`; it carries no other profile field.
 */
export const BrandingSchema = z.strictObject({
  displayName: z.string().nullable(),
  logo: z.strictObject({ tenantId: z.guid(), documentId: z.guid() }).nullable(),
});
export type Branding = z.infer<typeof BrandingSchema>;
