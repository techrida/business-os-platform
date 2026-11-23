'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Field } from '@/components/ui/field';
import { MemberPicker, type MemberOption } from '@/components/ui/member-picker';

import { checkHref } from './check-model';
import styles from './check.module.css';

/**
 * The "Person" box. Searching by name or email narrows the list; choosing someone puts them in the
 * address, so the report can be shared and Back works. Clearing the box clears the address.
 */
export function PersonPicker({
  options,
  value,
}: {
  options: readonly MemberOption[];
  value: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <Field label="Person" className={styles.picker ?? ''}>
      {(control) => (
        <MemberPicker
          labelledBy={control['aria-labelledby']}
          describedBy={control['aria-describedby']}
          people={options}
          value={value}
          open={open}
          onOpenChange={setOpen}
          placeholder="Search by name or email"
          emptyText="No people to choose from."
          noMatchText="No one matches."
          onChange={(id) => {
            if (id !== value) router.replace(checkHref(id));
          }}
        />
      )}
    </Field>
  );
}
