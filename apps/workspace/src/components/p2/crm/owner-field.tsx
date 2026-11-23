'use client';

import type { LeadOwnerOption } from '@bos/contracts';
import { useState, useTransition, type FormEvent } from 'react';

import { OwnerCell } from '@/app/(app)/leads/lead-cells';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { MemberPicker } from '@/components/ui/member-picker';
import { Stack } from '@/components/ui/stack';
import { toast } from '@/components/ui/toast';

/** What an owner change hands back. `reload`: the record changed underneath the page. */
export interface OwnerChangeState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  reload?: boolean;
  /** Saved, and the record is now outside what the caller may open (handed to someone else's scope). */
  handedAway?: boolean;
}

export type OwnerChangeAction = (
  prev: OwnerChangeState,
  form: FormData,
) => Promise<OwnerChangeState>;

export interface OwnerFieldProps {
  /** The record's id, posted as `idField`. */
  recordId: string;
  /** The form field the action reads the id from: `leadId` or `opportunityId`. */
  idField: string;
  /** The record's version as the page showed it; a stale page gets a 409, not an overwrite. */
  version: number;
  ownerUserId: string | null;
  /** The owner's display name from the record (D46); null without an owner. */
  ownerName: string | null;
  /** People the caller may hand the record to, exactly as the API's owners route lists them. */
  owners: readonly LeadOwnerOption[];
  action: OwnerChangeAction;
  /** The toast after a save, given the new owner's name. */
  savedMessage: (name: string) => string;
  /** A line under the select about what else moves with the record. */
  hint?: string | undefined;
  /** Called after a save that took the record out of the caller's reach. */
  onHandedAway?: ((name: string) => void) | undefined;
}

/** The name an option shows. The owners route may send an empty email, so never an empty label. */
export const ownerOptionName = (o: LeadOwnerOption): string =>
  o.displayName || o.email || 'Unnamed user';

/**
 * A record's owner (D38, F1-Q51): the owner with initials, and for callers who may hand the record
 * to someone else, a Select of the people the API accepts with a Save button. A caller whose list
 * holds only themselves (own scope) cannot reassign, so they see the owner alone. Shared by the lead
 * and the opportunity pages, which pass their own server action.
 */
export function OwnerField(props: OwnerFieldProps) {
  const { ownerUserId, ownerName, owners, version } = props;
  const owner = owners.find((o) => o.userId === ownerUserId);
  const display = (
    <OwnerCell
      name={ownerName}
      seedId={ownerUserId}
      imageDocumentId={owner?.avatarDocumentId ?? null}
    />
  );
  if (owners.length <= 1) return display;
  return (
    <Stack gap="small">
      {display}
      {/* A new version (after a save or another change) starts the editor from the page again. */}
      <OwnerEditor
        key={`${version}:${ownerUserId ?? ''}`}
        {...props}
        listed={owner !== undefined}
      />
    </Stack>
  );
}

function OwnerEditor({
  recordId,
  idField,
  version,
  ownerUserId,
  owners,
  action,
  savedMessage,
  hint,
  onHandedAway,
  listed,
}: OwnerFieldProps & { listed: boolean }) {
  // An owner missing from the list starts on an empty choice, so saving never reassigns silently.
  const current = listed ? (ownerUserId ?? '') : '';
  const [chosen, setChosen] = useState(current);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const unchanged = chosen === '' || chosen === ownerUserId;

  const people = owners.map((o) => ({
    id: o.userId,
    name: ownerOptionName(o),
    role: o.role ?? null,
  }));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter still submits while Save is disabled: nothing to change, or a save in flight.
    if (pending || unchanged) return;
    const data = new FormData(event.currentTarget);
    const next = owners.find((o) => o.userId === chosen);
    const name = next ? ownerOptionName(next) : 'the new owner';
    startTransition(async () => {
      const result = await action({}, data);
      if (result.ok) {
        setError(undefined);
        if (result.handedAway && onHandedAway) onHandedAway(name);
        else toast.success(savedMessage(name));
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
      <input type="hidden" name={idField} value={recordId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <Stack gap="small">
        <Field label="Change owner" hint={hint} error={error}>
          {(c) => (
            <MemberPicker
              labelledBy={c['aria-labelledby']}
              describedBy={c['aria-describedby']}
              invalid={c['aria-invalid'] === true}
              name="ownerUserId"
              people={people}
              value={chosen}
              onChange={(id) => {
                setChosen(id);
                setError(undefined);
              }}
              placeholder={listed ? 'Search by name' : 'Choose a new owner'}
              disabled={pending}
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
