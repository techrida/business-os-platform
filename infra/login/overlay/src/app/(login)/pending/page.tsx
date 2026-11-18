import { PendingVerification } from '@/components/auth/pending-verification';
import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pending');
  return { title: t('title') };
}

// Static screen: no session, user or settings lookups. Not linked from the sign-in flow yet.
export default function Page() {
  return <PendingVerification />;
}
