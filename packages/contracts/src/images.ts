// Pictures that belong to a record: the company logo, a user's profile picture, a customer's or vendor's logo.
// They travel through the documents pipeline (upload, type check, virus scan, tenant-scoped storage) as documents of
// the owner types below, so this file holds only what the pipeline and the screens must agree on.
import { z } from 'zod';

export * from './constants/images.js';

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

/** Body of `PUT /v1/images/:ownerType/:ownerId`: make a (clean or still scanning) uploaded image current, or null to remove. */
export const SetImageBodySchema = z.strictObject({ documentId: z.guid().nullable() });
export type SetImageBody = z.infer<typeof SetImageBodySchema>;

/**
 * The company's face for a screen or an email (R6Q20): the display name from `entity.profile` and the current primary
 * logo (`documentId` says which; the public read route is addressed by the tenant alone, `/v1/public/logo/:tenantId`,
 * and always serves the current logo; the web apps proxy it as `/brand/logo/:tenantId`). Either may be null: no name or no logo set. Read by any signed-in principal
 * (staff, customer, vendor) with `GET /v1/branding`; it carries no other profile field.
 */
export const BrandingSchema = z.strictObject({
  displayName: z.string().nullable(),
  logo: z.strictObject({ tenantId: z.guid(), documentId: z.guid() }).nullable(),
});
export type Branding = z.infer<typeof BrandingSchema>;
