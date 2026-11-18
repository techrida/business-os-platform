'use client';

import { useEffect } from 'react';

import { toast } from '@/components/ui/toast';

const MESSAGES = {
  attach: 'Draft saved.',
  saved: 'Your changes were saved.',
  submitted: 'Submitted for approval. You will get a notification when it is decided.',
};

export function MemoFeedback({ notice }: { notice: keyof typeof MESSAGES }) {
  useEffect(() => {
    toast.success(MESSAGES[notice], { id: 'memo-feedback' });
  }, [notice]);
  return null;
}
