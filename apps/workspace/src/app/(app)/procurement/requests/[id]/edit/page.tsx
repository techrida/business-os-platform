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
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import { getPermissionCheck } from '@/lib/live-permissions';

import layout from '../../../procurement.module.css';
import { updatePrAction } from '../../actions';
import { PrForm } from '../../_components/pr-form';
import { prFailure } from '../../_lib/failure';
import { valuesFromDto } from '../../_lib/forms';
import { isPrEditable, PR_STATUS_LABEL } from '../../_lib/model';

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
  // Mid-sentence in the title ("Edit PR-…", "Edit draft purchase request"); the crumb keeps the capital.
  const titleName = pr.number ?? 'draft purchase request';
  const editable =
    pr.can?.edit ??
    (isPrEditable(pr.status) && (await getPermissionCheck(session))('procurement.pr.create'));
  const departments = editable ? await listDepartments(session).catch(() => []) : [];
  const enabledCurrencies = editable ? await loadEnabledCurrencies(session) : [];
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
          enabledCurrencies={enabledCurrencies}
          action={updatePrAction}
          initial={valuesFromDto(pr)}
          mode="edit"
          requestLabel={titleName}
          idempotencyKey={randomUUID()}
          prId={pr.id}
          version={pr.version}
          cancelHref={back}
          reloadHref={`${back}/edit`}
        />
      ) : (
        <>
          <PageHeader title={`Edit ${titleName}`} />
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
