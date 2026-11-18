'use client';

import { useEffect } from 'react';

import { toast } from '@/components/ui/toast';

const MESSAGES = {
  approve: 'Your approval was recorded.',
  return: 'The request was returned to the person who prepared it.',
  reject: 'The request was rejected.',
};

export function DecisionFeedback({ decision }: { decision: keyof typeof MESSAGES }) {
  useEffect(() => {
    toast.success(MESSAGES[decision], { id: 'inbox-decision' });
  }, [decision]);
  return null;
}
