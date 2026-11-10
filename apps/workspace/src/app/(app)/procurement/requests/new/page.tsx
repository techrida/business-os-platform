import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';

import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { listDepartments } from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';

import { createPrAction } from '../actions';
import { PrForm } from '../_components/pr-form';
import { EMPTY_PR_VALUES } from '../_lib/forms';
import { prGrants } from '../_lib/model';

export const metadata: Metadata = { title: 'New purchase request · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewPurchaseRequestPage() {
  const session = await requireStaffSession('/procurement/requests/new');
  const allowed = prGrants(session.roles).create;
  const departments = allowed ? await listDepartments(session).catch(() => []) : [];
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
