'use client';
import type { ReactNode } from 'react';
import {
  Button,
  Disclosure as AriaDisclosure,
  DisclosurePanel,
  Heading,
} from 'react-aria-components';

import styles from './disclosure.module.css';
import { Icon } from './icon';

/**
 * A collapsible section: a heading button with a rotating chevron that grows and shrinks the panel below it.
 * Built on the React Aria disclosure, which owns `aria-expanded`, `aria-controls`, keyboard use and hiding the
 * collapsed content from assistive technology. Collapsed by default.
 */
export function Disclosure({
  title,
  children,
  defaultExpanded = false,
  className,
}: {
  title: string;
  children: ReactNode;
  defaultExpanded?: boolean;
  className?: string;
}) {
  return (
    <AriaDisclosure
      defaultExpanded={defaultExpanded}
      className={[styles.disclosure ?? '', className].filter(Boolean).join(' ')}
    >
      <Heading className={styles.heading ?? ''}>
        <Button slot="trigger" className={styles.trigger ?? ''}>
          <span>{title}</span>
          <Icon name="chevron-down" size={18} className={styles.chevron} />
        </Button>
      </Heading>
      <DisclosurePanel className={styles.panel ?? ''}>
        <div className={styles.content}>{children}</div>
      </DisclosurePanel>
    </AriaDisclosure>
  );
}
