import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { AuthHeading } from './auth-heading';
import { CheckCircleIcon, ClockIcon, MailIcon } from './icons';
import { StatusChip } from './status-chip';

/**
 * "Your account is awaiting verification" screen (Figma 261:7282). Static copy, no data: rendered by
 * the `/pending` route. Nothing in the current ZITADEL flow redirects here yet.
 * Styles: `.bos-pending*` in styles/bos-form.css.
 */
export function PendingVerification({ signInHref = '/loginname' }: { signInHref?: string }) {
  const t = useTranslations('pending');

  return (
    <div className="bos-pending">
      <span className="bos-pending__tile" aria-hidden="true">
        <ClockIcon />
      </span>
      <StatusChip variant="warning">{t('chip')}</StatusChip>
      <AuthHeading compact largeLead title={t('heading')} lead={t('lead')} />
      <ul className="bos-pending__details">
        <li className="bos-pending__row bos-pending__row--done">
          <CheckCircleIcon />
          <span>{t('submitted')}</span>
        </li>
        <li className="bos-pending__row">
          <MailIcon />
          <span>{t('watchMail')}</span>
        </li>
      </ul>
      <div className="bos-pending__actions">
        <Link className="bos-btn bos-btn--primary" href={signInHref}>
          {t('back')}
        </Link>
        <p className="bos-pending__caption">{t('caption')}</p>
      </div>
    </div>
  );
}
