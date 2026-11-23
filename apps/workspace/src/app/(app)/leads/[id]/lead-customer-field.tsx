'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Stack } from '@/components/ui/stack';
import { toast } from '@/components/ui/toast';

import { unlinkLeadCustomerAction } from '../actions';

/**
 * The lead page's "Organization" fact. A lead linked to a customer shows the link, and an editor gets "Unlink customer":
 * the company name stays as typed, the link (and the linked contact) goes, and conversion can create a new customer
 * again. Free text without a link is just the name.
 */
export function LeadCustomerField({
  leadId,
  version,
  customerId,
  companyName,
  editable,
}: {
  leadId: string;
  version: number;
  customerId: string | null;
  companyName: string;
  editable: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  if (customerId === null) return <>{companyName}</>;
  return (
    <Stack gap="small">
      <Link href={`/customers/${customerId}`}>{companyName}</Link>
      {editable ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await unlinkLeadCustomerAction(leadId, version);
                if (result.ok) {
                  setError('');
                  toast.success('Customer unlinked. The company name is kept.');
                } else setError(result.error);
              })
            }
          >
            Unlink customer
          </Button>
        </div>
      ) : null}
      {error ? (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      ) : null}
    </Stack>
  );
}
