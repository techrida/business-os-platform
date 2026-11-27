import { Card } from '@/components/ui/card';
import { Page } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/**
 * Shown while any signed-in page without its own loading screen waits for its data. The shell around it
 * is already on screen, so only the page area is a placeholder: a title bar and one card of rows.
 */
export default function AppLoading() {
  return (
    <Page aria-busy="true">
      <p className="sr-only" role="status">
        Loading
      </p>
      <div aria-hidden="true">
        <Skeleton height={28} width="24%" />
      </div>
      <Card aria-hidden="true">
        <Skeleton height={20} width="30%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
