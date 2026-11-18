import { clsx } from 'clsx';
import { StatusChip } from './status-chip';

export type ApprovalCardProps = {
  /** Approver's display name. */
  name: string;
  /** Avatar text. Derived from `name` (first letters of the first two words) when omitted. */
  initials?: string;
  /** Approver's role, shown as a chip next to the name. */
  role?: string;
  /** Second line, already localised: for example "Auth Ticket #REQ-9482 • Approved 12m ago". */
  detail?: string;
  /** Caption of the right-hand column, for example "Expires In". Rendered with `expiresValue`. */
  expiresLabel?: string;
  /** Value of the right-hand column, for example "23h 48m". */
  expiresValue?: string;
  className?: string;
};

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? '')
    .join('');
}

/** Approval summary shown above the new-password form: who approved the request, which ticket, and when it lapses. */
export function ApprovalCard({
  name,
  initials,
  role,
  detail,
  expiresLabel,
  expiresValue,
  className,
}: ApprovalCardProps) {
  return (
    <div className={clsx('bos-approval', className)}>
      <span className="bos-approval__avatar" aria-hidden="true">
        {initials ?? initialsOf(name)}
      </span>
      <div className="bos-approval__main">
        <div className="bos-approval__title">
          <span className="bos-approval__name">{name}</span>
          {role && <StatusChip variant="info">{role}</StatusChip>}
        </div>
        {detail && <span className="bos-approval__detail">{detail}</span>}
      </div>
      {expiresValue && (
        <div className="bos-approval__expires">
          {expiresLabel && <span>{expiresLabel}</span>}
          <span className="bos-approval__expires-value">{expiresValue}</span>
        </div>
      )}
    </div>
  );
}
