'use client';

// The logo on a customer or vendor detail page. The pages are server components, so this wrapper owns the refresh
// after an upload or a removal. Without edit rights it is the picture and its preview only.
import { useRouter } from 'next/navigation';

import { ImageUpload, type ImageUploadProps } from '@/components/ui/image-upload';

export function CompanyLogoUpload({
  ownerType,
  companyId,
  legalName,
  logoDocumentId,
  label,
  readOnly,
  size,
}: {
  ownerType: 'customer_logo' | 'vendor_logo';
  companyId: string;
  legalName: string;
  logoDocumentId: string | null;
  /** "Customer logo" or "Vendor logo": the group name and the preview title. */
  label: string;
  readOnly: boolean;
  /** The picture's size; the customer profile card shows it at `xlarge` (U12-Q4). Default `large`. */
  size?: ImageUploadProps['size'];
}) {
  const router = useRouter();
  return (
    <ImageUpload
      ownerType={ownerType}
      ownerId={companyId}
      imageDocumentId={logoDocumentId}
      name={legalName}
      seedId={companyId}
      shape="square"
      fit="contain"
      label={label}
      onChange={() => router.refresh()}
      readOnly={readOnly}
      size={size}
    />
  );
}
