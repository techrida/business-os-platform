import type { PortalDisplay, VendorPortalOnboardingView } from '@bos/contracts';

import { Alert } from '@/components/portal/alert';
import { displayFormat } from '@/lib/display';

/** The calendar day in Kathmandu of an instant, as YYYY-MM-DD, the form `displayFormat().day` takes. */
const kathmanduDay = (at: string): string =>
  new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' });

/**
 * Tells the vendor that a change to the company's details reset the checklist, and that every document is sent
 * again. It reads only `detailsChanged` of the onboarding view: when, and the name of the staff member who made it.
 */
export function DetailsChangedNote({
  detailsChanged,
  display,
  className,
  children,
}: {
  detailsChanged: NonNullable<VendorPortalOnboardingView['detailsChanged']>;
  display?: PortalDisplay | undefined;
  className?: string | undefined;
  children?: React.ReactNode;
}) {
  const { day } = displayFormat(display);
  return (
    <Alert tone="warning" role="status" {...(className ? { className } : {})}>
      Details changed on{' '}
      <time dateTime={detailsChanged.at}>{day(kathmanduDay(detailsChanged.at))}</time>
      {detailsChanged.by ? ` by ${detailsChanged.by}` : ''}; upload the documents again.
      {children}
    </Alert>
  );
}
