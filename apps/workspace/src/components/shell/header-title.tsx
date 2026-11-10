'use client';

import { usePathname } from 'next/navigation';

import { titleForPath } from '@/lib/nav';

import styles from './header.module.css';

/**
 * The page title in the header. The (app) layout cannot see the URL on the server, so this small
 * client component reads the path and looks the title up in the nav registry. It is a paragraph,
 * not a heading: each page owns its own h1.
 */
export function HeaderTitle() {
  const pathname = usePathname();
  return <p className={styles.title}>{titleForPath(pathname)}</p>;
}
