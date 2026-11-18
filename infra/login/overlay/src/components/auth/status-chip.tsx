import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export type StatusChipVariant = 'warning' | 'info';

export type StatusChipProps = {
  /** `warning`: amber "Pending verification". `info`: blue role chip ("IT Security Admin"). */
  variant?: StatusChipVariant;
  children: ReactNode;
  className?: string;
};

export function StatusChip({ variant = 'warning', children, className }: StatusChipProps) {
  return <span className={clsx('bos-chip', `bos-chip--${variant}`, className)}>{children}</span>;
}
