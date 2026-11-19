import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/button';

/** Shown when filters hide every row of a list that does have rows. Names the filters and offers a way out. */
export function FilteredEmpty({
  noun,
  labels,
  clearHref,
}: {
  /** Plural noun, such as "invoices". */
  noun: string;
  labels: readonly string[];
  clearHref: string;
}) {
  return (
    <EmptyState
      title={`No ${noun} match`}
      icon="search"
      action={
        <LinkButton variant="secondary" href={clearHref}>
          Clear filters
        </LinkButton>
      }
    >
      {labels.length > 0 ? `Hidden by ${labels.join('; ')}.` : 'Nothing matches your filters.'}
    </EmptyState>
  );
}
