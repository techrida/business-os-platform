import Link from 'next/link';
import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import {
  getPurchaseRequest,
  listCostCenters,
  listDepartments,
  type PurchaseRequestDto,
} from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';

import layout from '../../../procurement.module.css';
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
          actions={<Link href={`${back}/edit`}>Try again</Link>}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const label = pr.number ?? 'Draft purchase request';
  const editable = isPrEditable(pr.status) && prGrants(session.roles).create;
  const departments = editable ? await listDepartments(session).catch(() => []) : [];
  let costCenters: Awaited<ReturnType<typeof listCostCenters>> = [];
  if (editable) {
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
            actions={<Link href={`${back}/edit`}>Try again</Link>}
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
          { label, href: back },
          { label: 'Edit' },
        ]}
      />
      {editable ? (
        <PrForm
          departments={departments}
          costCenters={costCenters}
          action={updatePrAction}
          initial={valuesFromDto(pr)}
          mode="edit"
          requestLabel={label}
          idempotencyKey={randomUUID()}
          prId={pr.id}
          version={pr.version}
          cancelHref={back}
          reloadHref={`${back}/edit`}
        />
      ) : (
        <>
          <PageHeader title={`Edit ${label}`} />
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
        </>
      )}
    </Page>
  );
}
