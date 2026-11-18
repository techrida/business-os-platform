import { shortId } from '@/lib/kernel-ui';

export interface AuditActorRef {
  /** The person's display name, when the API or a frozen snapshot knows it. */
  name?: string | null | undefined;
  /** `user` for a person; `system`, `zitadel` and `seed` are not people. Defaults to `user`. */
  kind?: string | undefined;
  /** The stored actor id: a user uuid for a person, `system:<job>` and the like otherwise. */
  id: string;
}

/**
 * Who did it, in words: the person's name, else `person` and the short id (a person whose name is not
 * known, for example one of another tenant or an old row), else the kind of actor (`system`). A blank name
 * counts as no name.
 */
export function actorLabel({ name, kind = 'user', id }: AuditActorRef): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return kind === 'user' ? `person ${shortId(id)}` : kind;
}

/** The actor's name with the full id as a tooltip, so a short id can still be traced. */
export function AuditActor(props: AuditActorRef) {
  return <span title={props.id}>{actorLabel(props)}</span>;
}
