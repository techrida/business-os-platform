import { Page } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

// Shown while one department loads: breadcrumb, header, the People card's head field and rows.
export default function DepartmentLoading() {
  return (
    <Page aria-busy="true">
      <p className="sr-only" role="status">
        Loading department...
      </p>
      <Skeleton height={16} width="min(12rem, 100%)" />
      <Skeleton height={32} width="min(16rem, 100%)" />
      <Skeleton height={64} width="min(28rem, 100%)" />
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} height={56} />
      ))}
    </Page>
  );
}
