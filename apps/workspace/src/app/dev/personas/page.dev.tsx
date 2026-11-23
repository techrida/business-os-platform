import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { Card } from '@/components/ui/card';
import { CenteredPage } from '@/components/ui/centered-page';
import { Stack } from '@/components/ui/stack';
import { developmentAccounts, localDevelopmentRequest } from '@/dev/accounts.server';

export const dynamic = 'force-dynamic';

export default async function DevPersonasPage() {
  const incoming = await headers();
  if (
    !localDevelopmentRequest(
      new Request(process.env.WORKSPACE_PUBLIC_URL ?? 'http://invalid', { headers: incoming }),
    )
  )
    notFound();
  let accounts;
  try {
    accounts = await developmentAccounts();
  } catch {
    return (
      <CenteredPage>
        <Card role="alert">Development accounts unavailable. Check login-client setup.</Card>
      </CenteredPage>
    );
  }
  return (
    <CenteredPage width="wide">
      <Stack as="main" gap="large" data-marker="BOS_DEV_PERSONA_SWITCHER">
        <h1>Development accounts</h1>
        <p>
          Sign in with a real development identity. Includes active seeded and manually created
          users.
        </p>
        {accounts.map((account) => (
          <form noValidate key={account.id} method="post" action="/dev/api/accounts">
            <input type="hidden" name="account" value={account.id} />
            <button type="submit">{account.label}</button> <span>{account.login}</span>
          </form>
        ))}
      </Stack>
    </CenteredPage>
  );
}
