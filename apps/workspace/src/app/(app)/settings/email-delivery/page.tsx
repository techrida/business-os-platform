import type { EmailDeliveryDto, EmailDeliveryState } from '@bos/contracts';
import type { Metadata } from 'next';

import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { TabNav } from '@/components/ui/tab-nav';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { listEmailDeliveries } from '@/lib/api-email-delivery';
import { getPermissionCheck } from '@/lib/live-permissions';

import { BackToSettings } from '../_components/back-link';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { formatInstant } from '../format';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { ResendButton } from './resend-button';

export const metadata: Metadata = { title: 'Email delivery · Business OS' };

const PATH = '/settings/email-delivery';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATE: Record<
  EmailDeliveryState,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'error' }
> = {
  queued: { label: 'Waiting to send', tone: 'info' },
  sending: { label: 'Sending', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  bounced: { label: 'Bounced', tone: 'error' },
};

type RawParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function when(item: EmailDeliveryDto): string {
  return formatInstant(item.sentAt ?? item.createdAt);
}

export default async function EmailDeliveryPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const session = await requireSection('email-delivery');
  const params = await searchParams;
  const filter = one(params.show) === 'all' ? 'all' : 'failed';
  const rawBefore = one(params.before);
  const before = rawBefore !== undefined && UUID.test(rawBefore) ? rawBefore : undefined;

  const can = await getPermissionCheck(session);
  const canResend = can('email_delivery.resend');
  const page = await section('view the email delivery log', () =>
    listEmailDeliveries(session, { filter, before }),
  );

  const base = filter === 'all' ? `${PATH}?show=all` : PATH;
  const olderHref = (id: string) => `${base}${filter === 'all' ? '&' : '?'}before=${id}`;

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Email delivery"
        description="Emails the system sends for approvals, quotations and other notices. When one fails after every retry, or bounces, you can send it again here. Every resend is recorded in the audit trail."
      />
      <div className={styles.column}>
        <TabNav
          label="Which emails"
          activeHref={base}
          items={[
            { href: PATH, label: 'Needs attention' },
            { href: `${PATH}?show=all`, label: 'All emails' },
          ]}
        />
        <Panel
          title={filter === 'all' ? 'All emails' : 'Needs attention'}
          description={
            filter === 'all'
              ? 'Every email, newest first.'
              : 'Emails that failed after every retry, or bounced back from the mail server.'
          }
        >
          {!page.ok ? (
            <SectionError message={page.message} />
          ) : page.data.items.length === 0 ? (
            <EmptyState
              icon="mail"
              headingLevel={3}
              title={
                before !== undefined
                  ? 'No older emails'
                  : filter === 'all'
                    ? 'No emails yet'
                    : 'No failed emails'
              }
            >
              {filter === 'failed' && before === undefined
                ? 'Every email has been delivered or is still on its way.'
                : null}
            </EmptyState>
          ) : (
            <>
              <Table caption="Emails, newest first" minWidth={720}>
                <thead>
                  <tr>
                    <Th>Email</Th>
                    <Th>Status</Th>
                    <Th>Last change</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {page.data.items.map((item) => {
                    const state = STATE[item.state];
                    return (
                      <tr key={item.id}>
                        <Th scope="row" className={admin.rowHead}>
                          <CellTitle title={item.subject} meta={`To ${item.recipient}`} />
                        </Th>
                        <Td>
                          <CellTitle
                            title={<Badge tone={state.tone}>{state.label}</Badge>}
                            note={
                              item.lastError !== null &&
                              (item.state === 'failed' || item.state === 'bounced')
                                ? item.lastError
                                : item.resendCount > 0
                                  ? `Sent again ${item.resendCount === 1 ? 'once' : `${item.resendCount} times`}`
                                  : undefined
                            }
                          />
                        </Td>
                        <Td>{when(item)}</Td>
                        <Td align="end">
                          {item.canResend && canResend ? (
                            <ResendButton
                              id={item.id}
                              subject={item.subject}
                              recipient={item.recipient}
                            />
                          ) : null}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              {page.data.nextBefore === null ? null : (
                <LinkButton variant="tertiary" size="small" href={olderHref(page.data.nextBefore)}>
                  Show older emails
                </LinkButton>
              )}
            </>
          )}
        </Panel>
      </div>
    </Page>
  );
}
