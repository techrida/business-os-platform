'use client';

import type { LeadOwnerOption } from '@bos/contracts';
import { useState, useTransition, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Stack } from '@/components/ui/stack';
import { toast } from '@/components/ui/toast';

import { updateLeadOwnerAction } from '../actions';
import { OwnerCell } from '../lead-cells';

export interface LeadOwnerFieldProps {
  leadId: string;
  /** The lead's version as the page showed it; sent so a stale page gets a 409, not an overwrite. */
  version: number;
  ownerUserId: string | null;
  /** The owner's display name from the lead (D46); null without an owner. */
  ownerName: string | null;
  /** People the caller may hand the lead to (`GET /v1/leads/owners`). */
  owners: readonly LeadOwnerOption[];
}

const nameOf = (o: LeadOwnerOption) => o.displayName || o.email;

/**
 * The value of the lead page's "Lead owner" fact (D38): the owner with initials, and for callers
 * who may hand leads to someone else, a Select of owners with a Save button. A caller whose list
 * holds only themselves (own scope) cannot reassign, so they see the owner alone. Mount it as
 * `{ label: 'Lead owner', value: <LeadOwnerField ... /> }` in the overview facts.
 */
export function LeadOwnerField({
  leadId,
  version,
  ownerUserId,
  ownerName,
  owners,
}: LeadOwnerFieldProps) {
  const display = <OwnerCell name={ownerName} />;
  if (owners.length <= 1) return display;
  const listed = owners.some((o) => o.userId === ownerUserId);
  return (
    <Stack gap="small">
      {display}
      {/* A new version (after a save or another change) starts the editor from the page again. */}
      <OwnerEditor
        key={`${version}:${ownerUserId ?? ''}`}
        leadId={leadId}
        version={version}
        ownerUserId={ownerUserId}
        ownerName={ownerName}
        owners={owners}
        listed={listed}
      />
    </Stack>
  );
}

function OwnerEditor({
  leadId,
  version,
  ownerUserId,
  owners,
  listed,
}: LeadOwnerFieldProps & { listed: boolean }) {
  // An owner missing from the list starts on an empty choice, so saving never reassigns silently.
  const current = listed ? (ownerUserId ?? '') : '';
  const [chosen, setChosen] = useState(current);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const unchanged = chosen === '' || chosen === ownerUserId;

  const options = [
    ...(listed ? [] : [{ value: '', label: 'Choose a new owner' }]),
    ...owners.map((o) => ({ value: o.userId, label: nameOf(o) })),
  ];

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter still submits while Save is disabled: nothing to change, or a save in flight.
    if (pending || unchanged) return;
    const data = new FormData(event.currentTarget);
    const next = owners.find((o) => o.userId === chosen);
    startTransition(async () => {
      const result = await updateLeadOwnerAction({}, data);
      if (result.ok) {
        setError(undefined);
        toast.success(next ? `Lead owner changed to ${nameOf(next)}.` : 'Lead owner changed.');
        return;
      }
      const message =
        result.error ?? result.fieldErrors?.['ownerUserId'] ?? 'The owner could not be changed.';
      if (result.reload) {
        toast.error(message, {
          action: { label: 'Reload', onClick: () => window.location.reload() },
        });
        return;
      }
      // A refusal the person can act on stays next to the control (UIP-FEED-001), and toasts too.
      setError(message);
      toast.error(message);
    });
  }

  return (
    <form noValidate onSubmit={onSubmit} aria-busy={pending || undefined}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <Stack gap="small">
        <Field label="Change owner" error={error}>
          {(c) => (
            <Select
              name="ownerUserId"
              value={chosen}
              onChange={(e) => {
                setChosen(e.target.value);
                setError(undefined);
              }}
              options={options}
              disabled={pending}
              {...c}
            />
          )}
        </Field>
        <div>
          <Button
            type="submit"
            variant="secondary"
            size="small"
            disabled={pending || unchanged}
            aria-busy={pending || undefined}
          >
            {pending ? 'Saving' : 'Save owner'}
          </Button>
        </div>
      </Stack>
    </form>
  );
}
