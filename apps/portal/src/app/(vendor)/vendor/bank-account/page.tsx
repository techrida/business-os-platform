import { randomUUID } from 'node:crypto';

import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding } from '@/lib/api.vendor';
import { getSession } from '@/lib/session';

import { loadVendor } from '../load';
import { BankForm } from './_components/bank-form';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/bank-account';

/**
 * Ask to change the bank account we pay into. Needs a full vendor account: one still being set
 * up, suspended or closed gets the no-access notice in place, and a 403 from the API shows the
 * same notice. The page shows no account details: a request only proposes an account, and the
 * number is never shown back.
 */
export default async function BankAccountPage() {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const onboarding = await loadVendor(() => getVendorOnboarding(session), HERE);
  if (onboarding.kind === 'forbidden') return <VendorNoAccess />;
  if (onboarding.kind === 'missing') notFound();
  if (onboarding.data.capability !== 'full') return <VendorNoAccess />;

  const key = randomUUID();
  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Bank account</h1>
        <p className={pageStyles.lede}>
          Ask us to pay a different bank account. Our team checks a new account with you before we
          use it.
        </p>
      </div>
      <BankForm key={key} idempotencyKey={key} />
    </main>
  );
}
