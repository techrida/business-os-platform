'use client';

import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type TabListProps,
  type TabPanelProps,
  type TabProps,
  type TabsProps,
} from 'react-aria-components';

import styles from './tabs.module.css';

export function Tabs(props: Omit<TabsProps, 'orientation' | 'className'>) {
  return <AriaTabs {...props} />;
}

export function TabList<T extends object>(props: Omit<TabListProps<T>, 'className'>) {
  return <AriaTabList {...props} className={styles.list} />;
}

export function Tab(props: Omit<TabProps, 'className'>) {
  return <AriaTab {...props} className={styles.tab} />;
}

export function TabPanel(props: Omit<TabPanelProps, 'className'>) {
  return <AriaTabPanel {...props} className={styles.panel} />;
}
