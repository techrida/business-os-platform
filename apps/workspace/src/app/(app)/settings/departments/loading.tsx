import { Page } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

// Shown while the department list waits for the API: header, filters and skeleton rows. The
// blocks are hidden from assistive technology; the status text is what is announced.
export default function DepartmentsLoading() {
  return (
    <Page aria-busy="true">
      <p className="sr-only" role="status">
        Loading departments...
      </p>
      <Skeleton height={32} width="min(14rem, 100%)" />
      <Skeleton height={20} width="min(36rem, 100%)" />
      <Skeleton height={40} width="min(28rem, 100%)" />
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} height={52} />
      ))}
    </Page>
  );
}
