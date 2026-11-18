'use client';

import { useEffect, useId } from 'react';

import { toast } from '@/components/ui/toast';

export function SuccessNotice({ message }: { message: string }) {
  const id = useId();
  useEffect(() => {
    toast.success(message, { id });
  }, [id, message]);
  return null;
}
