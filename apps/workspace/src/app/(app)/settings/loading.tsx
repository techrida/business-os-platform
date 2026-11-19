import { Page } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

// Shown while an admin page waits for the API. The admin pages make several requests in parallel,
// so a slow one would otherwise leave the previous screen frozen with no sign that anything happens.
// The skeleton blocks are hidden from assistive technology; the status text is what is announced.
export default function AdminLoading() {
  return (
    <Page aria-busy="true">
      <p className="sr-only" role="status">
        Loading...
      </p>
      <Skeleton height={32} width="min(18rem, 100%)" />
      <Skeleton height={20} width="min(32rem, 100%)" />
      <Skeleton height={240} />
    </Page>
  );
}
