import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { listCostCenters, listDepartments } from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import { getGrants } from '@/lib/grants';

import layout from '../../procurement.module.css';
import { createPrAction } from '../actions';
import { PrForm } from '../_components/pr-form';
import { EMPTY_PR_VALUES } from '../_lib/forms';
import { prFailure } from '../_lib/failure';
import { prGrants } from '../_lib/model';

export const metadata: Metadata = { title: 'New purchase request · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewPurchaseRequestPage() {
  const session = await requireStaffSession('/procurement/requests/new');
  const allowed = prGrants(await getGrants(session)).create;
  const departments = allowed ? await listDepartments(session).catch(() => []) : [];
  const enabledCurrencies = allowed ? await loadEnabledCurrencies(session) : [];
  let costCenters: Awaited<ReturnType<typeof listCostCenters>> = [];
  if (allowed) {
    try {
      costCenters = await listCostCenters(session);
    } catch (err) {
      const failure = prFailure(err, 'load');
      return (
        <Page width="narrow">
          <Alert
            tone={failure.status === 403 ? 'info' : 'error'}
            role="alert"
            title="Cost centres did not load"
            actions={<Link href="/procurement/requests/new">Try again</Link>}
          >
            {failure.message}
          </Alert>
        </Page>
      );
    }
  }
  return (
    <Page className={layout.formPage}>
      <Breadcrumb
        items={[
          { label: 'Purchase requests', href: '/procurement/requests' },
          { label: 'New request' },
        ]}
      />
      {allowed ? (
        <PrForm
          departments={departments}
          costCenters={costCenters}
          enabledCurrencies={enabledCurrencies}
          action={createPrAction}
          initial={EMPTY_PR_VALUES}
          mode="create"
          idempotencyKey={randomUUID()}
          cancelHref="/procurement/requests"
          reloadHref="/procurement/requests/new"
        />
      ) : (
        <>
          <PageHeader
            title="New purchase request"
            description="Saved as a draft first. Submitting it sends it to the department head."
          />
          <Alert
            tone="info"
            role="status"
            title="Your roles do not include raising purchase requests"
            actions={
              <LinkButton href="/procurement/requests" variant="secondary">
                Back to purchase requests
              </LinkButton>
            }
          >
            Ask an administrator if you need to.
          </Alert>
        </>
      )}
    </Page>
  );
}
