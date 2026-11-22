'use client';

import type { CountryCode } from '@bos/contracts';
import type { ReactNode } from 'react';

import { CountrySelect } from './country-select';
import { Field, Input, Textarea } from './field';
import styles from './address-fields.module.css';

/** A structured address as a form holds it. `line` is the street lines, free text. */
export interface AddressValue {
  line: string;
  city: string;
  country: CountryCode;
}

export interface AddressFieldsProps {
  value: AddressValue;
  onChange: (next: AddressValue) => void;
  /** Names the posted fields `<name>.line`, `<name>.city` and `<name>.country`. */
  name?: string | undefined;
  /** Per-field errors, shown under each field and linked to it. */
  errors?: { line?: ReactNode; city?: ReactNode; country?: ReactNode } | undefined;
  /**
   * Whether Address and City must be filled. When false they are labelled "(optional)", the app's convention.
   * Country is always required.
   */
  required?: boolean | undefined;
  /** Overrides the field labels ("Address", "City", "Country"), e.g. "Registered address". */
  labels?: { line?: string; city?: string; country?: string } | undefined;
  hints?: { line?: ReactNode; city?: ReactNode; country?: ReactNode } | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

/** The longest address and city the contracts accept (`AddressLinesSchema`). */
const LINE_MAX = 500;
const CITY_MAX = 100;

/**
 * The three address fields every party form uses: Address (street lines, free text), City and Country (a searchable
 * CountrySelect, Nepal first). Controlled: the caller holds `{ line, city, country }`. Each field is a `Field`, so its
 * label, hint and error are wired to the control. City and Country sit side by side when there is room.
 *
 *   <AddressFields name="address" value={address} onChange={setAddress} required errors={errors.address} />
 */
export function AddressFields({
  value,
  onChange,
  name,
  errors,
  required = false,
  labels,
  hints,
  disabled,
  className,
}: AddressFieldsProps) {
  const optional = required ? '' : ' (optional)';
  const set = (patch: Partial<AddressValue>) => onChange({ ...value, ...patch });
  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')}>
      <div className={styles.grid}>
        <Field
          label={`${labels?.line ?? 'Address'}${optional}`}
          hint={hints?.line}
          error={errors?.line}
          className={styles.line ?? ''}
        >
          {(control) => (
            <Textarea
              {...control}
              {...(name ? { name: `${name}.line` } : {})}
              rows={2}
              maxLength={LINE_MAX}
              autoComplete="street-address"
              value={value.line}
              required={required}
              disabled={disabled === true}
              onChange={(event) => set({ line: event.target.value })}
            />
          )}
        </Field>
        <Field
          label={`${labels?.city ?? 'City'}${optional}`}
          hint={hints?.city}
          error={errors?.city}
        >
          {(control) => (
            <Input
              {...control}
              {...(name ? { name: `${name}.city` } : {})}
              type="text"
              maxLength={CITY_MAX}
              autoComplete="address-level2"
              value={value.city}
              required={required}
              disabled={disabled === true}
              onChange={(event) => set({ city: event.target.value })}
            />
          )}
        </Field>
        <Field label={labels?.country ?? 'Country'} hint={hints?.country} error={errors?.country}>
          {(control) => (
            <CountrySelect
              id={control.id}
              aria-labelledby={control['aria-labelledby']}
              aria-describedby={control['aria-describedby']}
              aria-invalid={control['aria-invalid']}
              {...(name ? { name: `${name}.country` } : {})}
              required
              disabled={disabled === true}
              value={value.country}
              onChange={(country) => set({ country })}
            />
          )}
        </Field>
      </div>
    </div>
  );
}
