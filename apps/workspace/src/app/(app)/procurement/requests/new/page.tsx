import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { listCostCenters, listDepartments } from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';

import { createPrAction } from '../actions';
import { PrForm } from '../_components/pr-form';
import { EMPTY_PR_VALUES } from '../_lib/forms';
import { prFailure } from '../_lib/failure';
import { prGrants } from '../_lib/model';

export const metadata: Metadata = { title: 'New purchase request ? Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewPurchaseRequestPage() {
  const session = await requireStaffSession('/procurement/requests/new');
  const allowed = prGrants(session.roles).create;
  const departments = allowed ? await listDepartments(session).catch(() => []) : [];
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
    <Page width="narrow">
      <Breadcrumb
        items={[
          { label: 'Purchase requests', href: '/procurement/requests' },
          { label: 'New request' },
        ]}
      />
      <PageHeader
        title="New purchase request"
        description="Saved as a draft first. Submitting it sends it to the department head."
      />
      {allowed ? (
        <PrForm
          departments={departments}
          costCenters={costCenters}
          action={createPrAction}
          initial={EMPTY_PR_VALUES}
          mode="create"
          idempotencyKey={randomUUID()}
          cancelHref="/procurement/requests"
          reloadHref="/procurement/requests/new"
        />
      ) : (
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
      )}
    </Page>
  );
}
