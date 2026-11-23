'use client';

import { useActionState, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Dialog, DialogClose } from '@/components/ui/dialog';

import { IDLE, type ActionState } from '../action-state';
import { FormStatus } from '../ui';
import { setRolesAction } from './actions';
import { RoleCheckboxes } from './role-checkboxes';
import { Tooltip } from '@/components/ui/tooltip';

export function RolesEditor({
  userId,
  label,
  roles,
}: {
  userId: string;
  label: string;
  roles: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(setRolesAction, IDLE);
  const [selected, setSelected] = useState<string[]>([...roles]);
  const [seen, setSeen] = useState<ActionState | null>(null);
  const formId = useId();
  const result = state === seen ? IDLE : state;

  return (
    <Dialog
      title="Edit roles"
      description={label}
      size="small"
      locked={pending}
      onOpenChange={(open) => {
        if (open) {
          setSelected([...roles]);
          setSeen(state);
        }
      }}
      trigger={
        <Tooltip content={`Edit roles for ${label}`}>
          <Button variant="ghost" size="small" aria-label={`Edit roles for ${label}`}>
            <Icon name="shield-check" size={20} />
          </Button>
        </Tooltip>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              {result.status === 'ok' ? 'Close' : 'Cancel'}
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending}>
            Save roles
          </Button>
        </>
      }
    >
      <form noValidate id={formId} action={formAction}>
        <input type="hidden" name="userId" value={userId} />
        <RoleCheckboxes
          idPrefix={formId}
          legend={`Roles for ${label}`}
          hideLegend
          checked={selected}
          onToggle={(role, on) =>
            setSelected((current) =>
              on ? [...current, role] : current.filter((key) => key !== role),
            )
          }
        />
        <FormStatus state={result} pending={pending} />
      </form>
    </Dialog>
  );
}
