import { Button, LinkButton } from '@/components/ui/button';

import styles from './procurement.module.css';

export function ProcurementFormActions({
  cancelHref,
  submitLabel,
  disabled,
}: {
  cancelHref: string;
  submitLabel: string;
  disabled: boolean;
}) {
  return (
    <div className={styles.formActions}>
      <LinkButton href={cancelHref} variant="secondary">
        Cancel
      </LinkButton>
      <Button type="submit" disabled={disabled}>
        {submitLabel}
      </Button>
    </div>
  );
}
