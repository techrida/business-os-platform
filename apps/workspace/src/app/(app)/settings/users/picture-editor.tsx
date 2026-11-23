'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { ImageUpload } from '@/components/ui/image-upload';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * A directory row's profile picture: an icon button beside the other row actions opens a dialog with the shared
 * image upload. The upload saves on its own (no Save step), so the footer only closes. After an upload or removal the
 * page refreshes, the row's avatar picks up the new picture and the dialog stays open on the scanning state. The API
 * still decides who may change the picture (`profile.avatar.write`, scope `all` for someone else's).
 */
export function PictureEditor({
  userId,
  name,
  label,
  imageDocumentId,
}: {
  userId: string;
  /** The person's name for the initials and the control names. */
  name: string;
  /** Name and email, telling apart two people with the same name. */
  label: string;
  imageDocumentId: string | null;
}) {
  const router = useRouter();
  const action = `Change ${name} picture`;

  return (
    <Dialog
      title="Profile picture"
      description={label}
      size="small"
      trigger={
        <Tooltip content={action}>
          <Button variant="ghost" size="small" aria-label={action}>
            <Icon name="user" size={20} />
          </Button>
        </Tooltip>
      }
      footer={
        <DialogClose asChild>
          <Button variant="secondary">Close</Button>
        </DialogClose>
      }
    >
      <ImageUpload
        ownerType="user_avatar"
        ownerId={userId}
        imageDocumentId={imageDocumentId}
        name={name}
        seedId={userId}
        shape="circle"
        fit="cover"
        label="Profile picture"
        onChange={() => router.refresh()}
      />
    </Dialog>
  );
}
