import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import {
  getPurchaseRequest,
  listDepartments,
  type PurchaseRequestDto,
} from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';

import { updatePrAction } from '../../actions';
import { PrForm } from '../../_components/pr-form';
import { prFailure } from '../../_lib/failure';
import { valuesFromDto } from '../../_lib/forms';
import { isPrEditable, PR_STATUS_LABEL, prGrants } from '../../_lib/model';

export const metadata: Metadata = { title: 'Edit purchase request · Business OS' };
export const dynamic = 'force-dynamic';

export default async function EditPurchaseRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isGuid(id)) notFound();
  const session = await requireStaffSession(`/procurement/requests/${id}/edit`);
  const back = `/procurement/requests/${encodeURIComponent(id)}`;

  let pr: PurchaseRequestDto;
  try {
    pr = await getPurchaseRequest(session, id);
  } catch (err) {
    const f = prFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title="The purchase request did not load"
          actions={<a href={`${back}/edit`}>Try again</a>}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const label = pr.number ?? 'Draft purchase request';
  const editable = isPrEditable(pr.status) && prGrants(session.roles).create;
  const departments = editable ? await listDepartments(session).catch(() => []) : [];
  return (
    <Page width="narrow">
      <Breadcrumb
        items={[
          { label: 'Purchase requests', href: '/procurement/requests' },
          { label, href: back },
          { label: 'Edit' },
        ]}
      />
      <PageHeader title={`Edit ${label}`} />
      {editable ? (
        <PrForm
          departments={departments}
          action={updatePrAction}
          initial={valuesFromDto(pr)}
          mode="edit"
          idempotencyKey={randomUUID()}
          prId={pr.id}
          version={pr.version}
          cancelHref={back}
          reloadHref={`${back}/edit`}
        />
      ) : (
        <Alert
          tone="info"
          role="status"
          title={
            isPrEditable(pr.status)
              ? 'Your roles do not include editing purchase requests'
              : 'This request is read-only'
          }
          actions={
            <LinkButton href={back} variant="secondary">
              Back to the request
            </LinkButton>
          }
        >
          {isPrEditable(pr.status)
            ? 'Ask an administrator if you need to.'
            : `It is ${PR_STATUS_LABEL[pr.status].text.toLowerCase()}. Only a draft or a returned request can be edited.`}
        </Alert>
      )}
    </Page>
  );
}
