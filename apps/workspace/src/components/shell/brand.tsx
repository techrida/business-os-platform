import { APP_NAME } from '@/lib/nav';
import { Icon } from '@/components/ui/icon';

import styles from './brand.module.css';
import { BrandLogo } from './brand-logo';

/**
 * What the company has set: its name and the same-origin address of its logo. Either may be null (nothing set, or the
 * branding could not be read); the lockup then shows the product name, as it did before logos.
 */
export interface BrandProps {
  className?: string;
  name?: string | null | undefined;
  logoSrc?: string | null | undefined;
}

/** Brand lockup: the star mark, then the company logo, or the company name, or the product name. */
export function Brand({ className, name, logoSrc }: BrandProps) {
  const label = name?.trim() || APP_NAME;
  const text = (
    <span className={styles.name} data-brand-name="">
      {label}
    </span>
  );
  return (
    <span className={[styles.brand, className].filter(Boolean).join(' ')}>
      <span className={styles.mark}>
        <Icon name="star" size={16} />
      </span>
      {/* The sidebar hides the name (or the logo) in the rail through this attribute. */}
      {logoSrc ? <BrandLogo src={logoSrc} alt={label} fallback={text} /> : text}
    </span>
  );
}
