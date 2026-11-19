import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { getPurchaseRequest, type PurchaseRequestDto } from '@/lib/api-procurement';
import { getRfq, listSubmissions, type RfqDto } from '@/lib/api-rfqs';
import { listTaxCodes } from '@/lib/api-tax-codes';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import layout from '../../../../procurement.module.css';
import { recordQuotationAction } from '../../../actions';
import { QuoteForm, type SubmissionInfo } from '../../../_components/quote-form';
import { rfqFailure } from '../../../_lib/failure';
import { rfqGrants, submissionConvertibility, takesQuotations } from '../../../_lib/model';

export const metadata: Metadata = { title: 'Enter a quotation · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewQuotationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ submission?: string | string[] }>;
}) {
  const { id } = await params;
  if (!isGuid(id)) notFound();
  const session = await requireStaffSession(`/procurement/rfqs/${id}/quotations/new`);
  const sp = await searchParams;
  const back = `/procurement/rfqs/${encodeURIComponent(id)}`;
  const submissionId = typeof sp.submission === 'string' ? sp.submission : '';
  const here =
    submissionId !== ''
      ? `${back}/quotations/new?submission=${encodeURIComponent(submissionId)}`
      : `${back}/quotations/new`;

  let rfq: RfqDto;
  let pr: PurchaseRequestDto;
  try {
    rfq = await getRfq(session, id);
    pr = await getPurchaseRequest(session, rfq.purchaseRequestId);
  } catch (err) {
    const f = rfqFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[
            { label: 'Requests for quotation', href: '/procurement/rfqs' },
            { label: 'RFQ', href: back },
            { label: 'Enter a quotation' },
          ]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'Your roles do not include this RFQ' : 'The RFQ did not load'}
          actions={f.status !== 403 ? <Link href={here}>Try again</Link> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const convert = submissionId !== '';
  const crumbs = (
    <Breadcrumb
      items={[
        { label: 'Requests for quotation', href: '/procurement/rfqs' },
        { label: rfq.number, href: back },
        { label: convert ? 'Convert a submission' : 'Enter a quotation' },
      ]}
    />
  );
  const header = (
    <>
      {crumbs}
      <PageHeader
        title={convert ? 'Convert a vendor submission' : 'Enter a quotation'}
        description={`For ${rfq.number}. A quotation is recorded for one invited vendor, once.`}
      />
    </>
  );
  const blocked = (title: string, message: string) => (
    <Page width="narrow">
      {header}
      <Alert
        tone="info"
        role="status"
        title={title}
        actions={
          <LinkButton href={back} variant="secondary">
            Back to the RFQ
          </LinkButton>
        }
      >
        {message}
      </Alert>
    </Page>
  );

  if (!rfqGrants(session.roles).sourcing) {
    return blocked(
      'Your roles do not include sourcing',
      'Ask an administrator if you need to enter quotations.',
    );
  }
  if (!takesQuotations(rfq.status)) {
    return blocked(
      'This RFQ takes no more quotations',
      'Quotations can only be added while the RFQ is open for quotations.',
    );
  }

  let submission: SubmissionInfo | undefined;
  if (convert) {
    let found;
    try {
      found = (await listSubmissions(session, id)).find((s) => s.id === submissionId);
    } catch (err) {
      return blocked('The vendor submissions did not load', rfqFailure(err, 'load').message);
    }
    if (found === undefined) {
      return blocked(
        'That submission is not waiting',
        'It may already be converted, rejected or withdrawn, or it belongs to another RFQ.',
      );
    }
    const c = submissionConvertibility(found.scanStatus);
    if (!c.convertible) {
      return blocked(`The file from ${found.vendorName} cannot be converted yet`, c.reason);
    }
    submission = {
      id: found.id,
      vendorName: found.vendorName,
      vendorRef: found.vendorRef,
      sentAt: when(found.submittedAt),
    };
  }

  const { taxCodes, problem: taxCodeProblem } = await listTaxCodes(session).then(
    (rows) => ({ taxCodes: rows, problem: undefined }),
    (err) => ({ taxCodes: null, problem: rfqFailure(err, 'load') }),
  );

  return (
    <Page className={layout.formPage}>
      {crumbs}
      <QuoteForm
        action={recordQuotationAction}
        idempotencyKey={randomUUID()}
        rfqId={rfq.id}
        rfqNumber={rfq.number}
        mode={convert ? 'convert' : 'record'}
        vendors={rfq.vendors}
        {...(submission !== undefined ? { submission } : {})}
        prLines={pr.lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          description: l.description,
          uom: l.uom,
          quantity: l.quantity,
        }))}
        taxCodes={taxCodes}
        {...(taxCodeProblem !== undefined ? { taxCodeProblem } : {})}
        cancelHref={back}
        reloadHref={here}
      />
    </Page>
  );
}
