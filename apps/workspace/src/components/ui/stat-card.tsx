import type { ReactNode } from 'react';

import { Card } from './card';
import { Icon, type IconName } from './icon';
import styles from './stat-card.module.css';

type StatCardProps = {
  label: string;
  value: ReactNode;
  icon?: IconName;
  tone?: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  detail?: ReactNode;
};

export function StatCard({ label, value, icon, tone = 'info', detail }: StatCardProps) {
  return (
    <Card className={styles.card}>
      {icon && (
        <span className={`${styles.icon} ${styles[tone]}`}>
          <Icon name={icon} size={16} />
        </span>
      )}
      <dl>
        <dt className={styles.label}>{label}</dt>
        <dd className={styles.value}>{value}</dd>
      </dl>
      {detail && <div className={styles.detail}>{detail}</div>}
    </Card>
  );
}
