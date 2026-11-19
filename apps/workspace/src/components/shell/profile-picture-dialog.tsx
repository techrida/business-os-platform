'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
  // A new picture answers 404 until its scan clears, and Avatar does not retry a picture that failed. Closing the
  // dialog gives the sidebar picture a fresh try, so it appears without a full reload.
  const [revision, setRevision] = useState(0);
  return (
    <Dialog
      title="Profile picture"
      size="small"
      onOpenChange={(open) => {
        if (!open) setRevision((r) => r + 1);
      }}
      trigger={
        <button type="button" className={shellStyles.iconButton} aria-label="Profile picture">
          <Avatar
            key={revision}
            name={name}
            seedId={userId}
            imageDocumentId={imageDocumentId}
          />
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
