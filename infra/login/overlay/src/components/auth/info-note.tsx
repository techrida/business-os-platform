import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { InfoIcon } from './icons';

export type InfoNoteProps = {
  children: ReactNode;
  className?: string;
  id?: string;
};

/** Blue explanatory note under a field ("Workflow: your IT Admin will receive..."). A static note, not an alert. */
export function InfoNote({ children, className, id }: InfoNoteProps) {
  return (
    <div id={id} role="note" className={clsx('bos-info-note', className)}>
      <InfoIcon className="bos-info-note__icon" />
      <div className="bos-info-note__body">{children}</div>
    </div>
  );
}
