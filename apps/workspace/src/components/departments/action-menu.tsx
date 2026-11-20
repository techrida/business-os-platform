'use client';

import { RowMenu } from '@/components/ui/row-menu';

import styles from './departments.module.css';

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
}

/**
 * The "More" button of a phone card. Delegates to the shared RowMenu popover so surface tokens,
 * 8 px trigger offset, collision flipping and keyboard navigation stay uniform.
 */
export function ActionMenu({ label, items }: { label: string; items: readonly ActionMenuItem[] }) {
  return <RowMenu label={label} items={items} triggerClassName={styles.iconButton} />;
}
