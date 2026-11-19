'use client';

import { ROLE_KEYS, type AdminUser, type AdminUsersQuery } from '@bos/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { SearchInput } from '@/components/ui/search-input';

import { roleLabel } from './role-checkboxes';
import styles from './users.module.css';

type Filters = Pick<AdminUsersQuery, 'q' | 'status' | 'role' | 'departmentId' | 'sort' | 'limit'>;

export function UsersFilters({
  filters,
  departments,
  clearHref,
}: {
  filters: Filters;
  departments: NonNullable<AdminUser['department']>[];
  clearHref?: string | undefined;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pending, startTransition] = useTransition();

  const q = filters.q ?? '';
  const status = filters.status ?? '';
  const role = filters.role ?? '';
  const departmentId = filters.departmentId ?? '';
  const sort = filters.sort ?? 'name';

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const search = formRef.current?.elements.namedItem('q');
    // Updates from typing can arrive while the user is already entering the next search.
    if (search instanceof HTMLInputElement && document.activeElement !== search) search.value = q;
  }, [q]);
  useEffect(() => {
    for (const [name, value] of Object.entries({ departmentId, status, role, sort })) {
      const field = formRef.current?.elements.namedItem(name);
      if (field instanceof HTMLSelectElement) field.value = value;
    }
  }, [departmentId, status, role, sort]);

  function apply(form: HTMLFormElement) {
    clearTimeout(timer.current);
    const query = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      if (typeof value === 'string' && value.trim()) query.set(key, value.trim());
    }
    startTransition(() => router.replace(`/admin/users?${query}`, { scroll: false }));
  }

  function schedule(form: HTMLFormElement | null) {
    clearTimeout(timer.current);
    if (form) timer.current = setTimeout(() => apply(form), 300);
  }

  return (
    <form
      ref={formRef}
      className={styles.filters}
      role="search"
      action="/admin/users"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        apply(event.currentTarget);
      }}
    >
      <input type="hidden" name="limit" value={filters.limit} />
      <SearchInput
        name="q"
        defaultValue={q}
        maxLength={200}
        aria-label="Search users"
        placeholder="Search name or email"
        wrapperClassName={styles.search}
        onChange={(event) => {
          if (!(event.nativeEvent as InputEvent).isComposing) schedule(event.currentTarget.form);
          else clearTimeout(timer.current);
        }}
        onCompositionEnd={(event) => schedule(event.currentTarget.form)}
      />
      <div className={styles.filterActions}>
        <Select
          name="departmentId"
          aria-label="Filter by department"
          defaultValue={departmentId}
          onChange={(event) => apply(event.currentTarget.form!)}
        >
          <option value="">All departments</option>
          {departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
          {departmentId && !departments.some(({ id }) => id === departmentId) && (
            <option value={departmentId}>Unavailable department</option>
          )}
        </Select>
        <Select
          name="status"
          aria-label="Filter by status"
          defaultValue={status}
          onChange={(event) => apply(event.currentTarget.form!)}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="inactive">Inactive</option>
        </Select>
        <Select
          name="role"
          aria-label="Filter by role"
          defaultValue={role}
          onChange={(event) => apply(event.currentTarget.form!)}
        >
          <option value="">All roles</option>
          {ROLE_KEYS.map((key) => (
            <option key={key} value={key}>
              {roleLabel(key)}
            </option>
          ))}
        </Select>
        <Select
          name="sort"
          aria-label="Sort users"
          defaultValue={sort}
          onChange={(event) => apply(event.currentTarget.form!)}
        >
          <option value="name">Name</option>
          <option value="lastActive">Last active</option>
          <option value="createdAt">Newest</option>
        </Select>
        {clearHref && (
          <Link href={clearHref} onClick={() => clearTimeout(timer.current)}>
            Clear
          </Link>
        )}
        <noscript>
          <Button type="submit" variant="secondary" size="small">
            Apply
          </Button>
        </noscript>
      </div>
    </form>
  );
}
