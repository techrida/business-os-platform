'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Icon } from '@/components/ui/icon';

import styles from './shell.module.css';

/**
 * The only client state in the shell: the sidebar collapse (wide screens) and the drawer
 * (under 768px). Everything else in the shell stays a server component. The state is written to
 * data attributes on the frame, and the stylesheet does the rest, so there is one sidebar
 * element in every mode.
 */

const SIDEBAR_ID = 'app-sidebar';
const MENU_BUTTON_ID = 'shell-menu-button';
const DRAWER_CLOSE_ID = 'shell-drawer-close';

interface ShellState {
  collapsed: boolean;
  drawerOpen: boolean;
  navQuery: string;
  setNavQuery: (query: string) => void;
  toggleCollapsed: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const value = useContext(ShellContext);
  if (!value) throw new Error('Shell controls must be rendered inside <ShellFrame>.');
  return value;
}

export function ShellFrame({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navQuery, setNavQuery] = useState('');
  const wasOpen = useRef(false);

  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // While the drawer is open: Escape closes it, and growing the window past the drawer
  // breakpoint closes it (the drawer does not exist at that width).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    const wide = window.matchMedia('(min-width: 768px)');
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    wide.addEventListener('change', onChange);
    return () => {
      document.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onChange);
    };
  }, [drawerOpen]);

  // Focus moves into the drawer when it opens and back to the menu button when it closes.
  useEffect(() => {
    if (drawerOpen) {
      document.getElementById(DRAWER_CLOSE_ID)?.focus();
    } else if (wasOpen.current) {
      document.getElementById(MENU_BUTTON_ID)?.focus();
    }
    wasOpen.current = drawerOpen;
  }, [drawerOpen]);

  const value = useMemo(
    () => ({
      collapsed,
      drawerOpen,
      navQuery,
      setNavQuery,
      toggleCollapsed,
      openDrawer,
      closeDrawer,
    }),
    [collapsed, drawerOpen, navQuery, toggleCollapsed, openDrawer, closeDrawer],
  );

  return (
    <ShellContext.Provider value={value}>
      <div
        className={styles.frame}
        data-shell-collapsed={collapsed ? 'true' : 'false'}
        data-shell-drawer={drawerOpen ? 'open' : 'closed'}
      >
        {children}
        {/* Clicking outside the drawer closes it. Keyboard users have Escape and the close button. */}
        <button
          type="button"
          className={styles.scrim}
          tabIndex={-1}
          aria-hidden="true"
          onClick={closeDrawer}
        />
      </div>
    </ShellContext.Provider>
  );
}

/** The column to the right of the sidebar. It is inert while the drawer is open (focus trap). */
export function ShellMain({ children }: { children: ReactNode }) {
  const { drawerOpen } = useShell();
  return (
    <div className={styles.column} inert={drawerOpen}>
      {children}
    </div>
  );
}

/** Wide screens: collapse the sidebar to the 108px rail, or expand it again. */
export function CollapseToggle() {
  const { collapsed, toggleCollapsed } = useShell();
  return (
    <button
      type="button"
      className={`${styles.iconButton} ${styles.collapseToggle}`}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      aria-controls={SIDEBAR_ID}
      onClick={toggleCollapsed}
    >
      <Icon name={collapsed ? 'chevrons-right' : 'chevrons-left'} size={18} />
    </button>
  );
}

/** Phones: the menu button in the header that opens the drawer. */
export function MenuButton() {
  const { drawerOpen, openDrawer } = useShell();
  return (
    <button
      type="button"
      id={MENU_BUTTON_ID}
      className={`${styles.iconButton} ${styles.menuButton}`}
      aria-label="Open menu"
      aria-expanded={drawerOpen}
      aria-controls={SIDEBAR_ID}
      onClick={openDrawer}
    >
      <Icon name="menu" size={20} />
    </button>
  );
}

/** Phones: the close button inside the drawer. */
export function DrawerCloseButton() {
  const { closeDrawer } = useShell();
  return (
    <button
      type="button"
      id={DRAWER_CLOSE_ID}
      className={`${styles.iconButton} ${styles.drawerClose}`}
      aria-label="Close menu"
      onClick={closeDrawer}
    >
      <Icon name="x" size={18} />
    </button>
  );
}
