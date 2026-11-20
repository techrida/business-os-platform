// Pure wording and state rules for the access review dialog (spec 7.3). No React, so the rules are
// tested on their own and the dialog only lays them out.
import type { AccessImpactBucket, AccessWarning, AccessWarningCode } from '@bos/contracts';

export const ACCESS_SAVED_MESSAGE = 'Access saved. It applies within a few seconds.';

/** "Asha K., Bibek R., Chandra T. and 3 others", or "" when the bucket names nobody. */
export function sampleNames(bucket: AccessImpactBucket): string {
  const shown = bucket.sample.slice(0, 3);
  if (shown.length === 0) return '';
  const others = bucket.people - shown.length;
  if (others <= 0) {
    if (shown.length === 1) return shown[0] ?? '';
    return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
  }
  return `${shown.join(', ')} and ${others} ${others === 1 ? 'other' : 'others'}`;
}

/** "6 people will see more: Asha K., ..." / "No one will see less." */
export function impactSentence(bucket: AccessImpactBucket, direction: 'more' | 'less'): string {
  if (bucket.people === 0) return `No one will see ${direction}.`;
  const who = bucket.people === 1 ? '1 person' : `${bucket.people} people`;
  const names = sampleNames(bucket);
  if (!names) return `${who} will see ${direction}.`;
  // "Asha K." already ends the sentence.
  return `${who} will see ${direction}: ${names}${names.endsWith('.') ? '' : '.'}`;
}

export function hasBlockedWarning(warnings: readonly AccessWarning[]): boolean {
  return warnings.some((warning) => warning.severity === 'blocked');
}

/** A stable key per warning, so a tick stays with its warning when the list is re-read. */
export function warningKey(warning: AccessWarning, index: number): string {
  return `${warning.code}:${warning.changeIndex ?? 'x'}:${index}`;
}

/** The codes sent as `acknowledged`: every ticked confirm warning, each code once. */
export function acknowledgedCodes(
  warnings: readonly AccessWarning[],
  ticked: ReadonlySet<string>,
): AccessWarningCode[] {
  const codes = new Set<AccessWarningCode>();
  warnings.forEach((warning, index) => {
    if (warning.severity === 'confirm' && ticked.has(warningKey(warning, index))) {
      codes.add(warning.code);
    }
  });
  return [...codes];
}

/** True when every confirm warning is ticked. */
export function allConfirmed(
  warnings: readonly AccessWarning[],
  ticked: ReadonlySet<string>,
): boolean {
  return warnings.every(
    (warning, index) => warning.severity !== 'confirm' || ticked.has(warningKey(warning, index)),
  );
}

/**
 * After the server asks again for confirmation, keep a tick only on warnings whose code was
 * already acknowledged; new codes start unticked.
 */
export function carryTicks(
  next: readonly AccessWarning[],
  acknowledged: readonly AccessWarningCode[],
): Set<string> {
  const known = new Set(acknowledged);
  const ticks = new Set<string>();
  next.forEach((warning, index) => {
    if (warning.severity === 'confirm' && known.has(warning.code)) {
      ticks.add(warningKey(warning, index));
    }
  });
  return ticks;
}

export interface SaveGate {
  previewed: boolean;
  saving: boolean;
  warnings: readonly AccessWarning[];
  ticked: ReadonlySet<string>;
}

/** Save is possible only after a successful preview, with no blocked warning and every box ticked. */
export function canSave({ previewed, saving, warnings, ticked }: SaveGate): boolean {
  return previewed && !saving && !hasBlockedWarning(warnings) && allConfirmed(warnings, ticked);
}

export const NOTE_LIMIT = 280;
