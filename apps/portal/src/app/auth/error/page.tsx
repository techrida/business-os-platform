import { NoticeCard } from '@/components/shell/notice-card';
import { Badge } from '@/components/ui/badge';
import { CenteredPage } from '@/components/ui/centered-page';
import { LinkButton } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

// The code comes from the URL, so it is only shown when it is one we issue. Anything else would
// let a crafted link put arbitrary text on a page under our domain.
const KNOWN_CODES = ['idp_error', 'callback_failed'] as const;

function knownCode(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return KNOWN_CODES.find((c) => c === value) ?? 'unknown';
}

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const code = knownCode((await searchParams).code);
  return (
    <CenteredPage>
      <NoticeCard
        title="We could not sign you in"
        actions={
          // A plain link on purpose: /auth/login is a route handler, not a page to prefetch.
          <LinkButton href="/auth/login">Try again</LinkButton>
        }
      >
        <p>Something went wrong while signing in. Please try again.</p>
        <p>
          Error code:{' '}
          <Badge tone="error">
            <code>{code}</code>
          </Badge>
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
