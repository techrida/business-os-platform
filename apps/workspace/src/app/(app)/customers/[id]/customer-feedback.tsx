'use client';

import { useEffect } from 'react';

import { toast } from '@/components/ui/toast';

export function CustomerFeedback({ created, href }: { created: boolean; href: string }) {
  useEffect(() => {
    toast.success(created ? 'Organization created' : 'Changes saved', {
      id: href,
      ...(created ? { description: 'Start verification to collect and review documents.' } : {}),
    });
    window.history.replaceState(null, '', href);
  }, [created, href]);

  return null;
}
