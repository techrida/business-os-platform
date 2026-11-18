import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export type AuthHeadingProps = {
  title: ReactNode;
  /** Lead paragraph under the title. */
  lead?: ReactNode;
  /** Heading level; the page's main heading is `h1`. */
  as?: 'h1' | 'h2';
  /** 32/40 title, used on the pending-verification screen. */
  compact?: boolean;
  /** 16/24 lead, used on the pending-verification screen. */
  largeLead?: boolean;
  className?: string;
  titleId?: string;
};

/** H1 plus lead paragraph. Type styles come from `.bos-auth h1` and `.bos-auth .ztdl-p` in bos-form.css. */
export function AuthHeading({
  title,
  lead,
  as: Heading = 'h1',
  compact,
  largeLead,
  className,
  titleId,
}: AuthHeadingProps) {
  return (
    <div
      className={clsx(
        'bos-auth-heading',
        compact && 'bos-auth-heading--compact',
        largeLead && 'bos-auth-heading--large-lead',
        className,
      )}
    >
      <Heading id={titleId}>{title}</Heading>
      {lead && <p className="ztdl-p">{lead}</p>}
    </div>
  );
}
