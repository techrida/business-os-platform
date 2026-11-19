'use client';

import { useRouter } from 'next/navigation';

import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { ImageUpload } from '@/components/ui/image-upload';

import shellStyles from './shell.module.css';

export interface ProfilePictureDialogProps {
  /** The signed-in person's `app.users.id`: the picture's owner and the initials colour. */
  userId: string;
  imageDocumentId: string | null;
  /** The name beside the picture in the sidebar: initials, alt text and the controls' accessible names. */
  name: string;
}

/**
 * The sidebar's account picture as a button that opens the person's own profile picture. Every staff role may
 * change their own; the API checks it. After an upload or removal the server components reload, so the sidebar
 * picks up the new pointer.
 */
export function ProfilePictureDialog({ userId, imageDocumentId, name }: ProfilePictureDialogProps) {
  const router = useRouter();
  return (
    <Dialog
      title="Profile picture"
      size="small"
      trigger={
        <button type="button" className={shellStyles.iconButton} aria-label="Profile picture">
          <Avatar name={name} seedId={userId} imageDocumentId={imageDocumentId} />
        </button>
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
        label="Your profile picture"
        onChange={() => router.refresh()}
      />
    </Dialog>
  );
}
