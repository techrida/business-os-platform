// The pure rules of the Lost reasons card (D49): checking a label before any request, the order after a move, and
// whether the list is still the defaults (so the reset button only shows when there is something to reset). The API
// repeats the label rules; these only save a round trip and give the message beside the field.
import {
  DEFAULT_LEAD_LOST_REASONS,
  LEAD_LOST_REASON_LABEL_MAX,
  type LeadLostReason,
} from '@bos/contracts';

export const normalizeLabel = (label: string): string => label.trim().toLowerCase();

/** The message for a label that cannot be saved, or null when it can. `exceptId` is the option being renamed. */
export function labelProblem(
  label: string,
  reasons: readonly LeadLostReason[],
  exceptId?: string,
): string | null {
  const trimmed = label.trim();
  if (trimmed === '') return 'Enter a name for the reason.';
  if (trimmed.length > LEAD_LOST_REASON_LABEL_MAX) {
    return `Keep the reason to ${LEAD_LOST_REASON_LABEL_MAX} characters or fewer.`;
  }
  const clash = reasons.find(
    (r) => r.id !== exceptId && normalizeLabel(r.label) === normalizeLabel(trimmed),
  );
  if (clash) {
    return clash.retired
      ? `"${clash.label}" is already on the list, retired. Restore it instead.`
      : `"${clash.label}" is already on the list.`;
  }
  return null;
}

/** Every id in the order after moving `id` one place up or down; the same order when it is already at that end. */
export function movedOrder(
  reasons: readonly LeadLostReason[],
  id: string,
  direction: 'up' | 'down',
): string[] {
  const ids = [...reasons].sort((a, b) => a.position - b.position).map((r) => r.id);
  const from = ids.indexOf(id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  ids[from] = ids[to]!;
  ids[to] = id;
  return ids;
}

/** True when the list is exactly the shipped defaults, in order, with none retired and none added. */
export function isDefaultList(reasons: readonly LeadLostReason[]): boolean {
  const sorted = [...reasons].sort((a, b) => a.position - b.position);
  return (
    sorted.length === DEFAULT_LEAD_LOST_REASONS.length &&
    sorted.every(
      (r, i) => r.isDefault && !r.retired && r.label === DEFAULT_LEAD_LOST_REASONS[i]!.label,
    )
  );
}
