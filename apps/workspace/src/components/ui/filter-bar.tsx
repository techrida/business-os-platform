'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';

import { hrefWith, normalizeSearch, SEARCH_MAX_CHARS } from '@/lib/list-params';

import styles from './filter-bar.module.css';
import { SearchInput } from './search-input';

type ParamValue = string | readonly string[] | undefined;

type FilterNavigation = {
  /** Set or clear one filter in the URL (push). Empty string, empty array and undefined clear it. */
  setParam: (name: string, value: ParamValue) => void;
  pending: boolean;
};

const FilterNavigationContext = createContext<FilterNavigation | null>(null);

/** For controls placed inside a FilterBar, such as a MultiSelect's `onChange`. */
export function useFilterNavigation(): FilterNavigation {
  const value = useContext(FilterNavigationContext);
  if (!value) throw new Error('useFilterNavigation must be used inside a FilterBar');
  return value;
}

type FilterBarProps = {
  search?: { label: string; placeholder?: string; name?: string };
  /** Params the form must keep when it submits without JavaScript, such as `rows` or `view`. */
  preserve?: Readonly<Record<string, string | undefined>>;
  /** MultiSelect, Select and date controls. Give each a `name` so no-JS submit includes it. */
  children?: ReactNode;
  className?: string;
};

const DEBOUNCE_MS = 250;

/**
 * List filters as a real GET form, so Enter works without JavaScript. With JavaScript the URL
 * is updated in place and the server component re-renders; there is no Apply button.
 */
export function FilterBar({ search, preserve, children, className }: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const searchName = search?.name ?? 'q';
  const urlKey = searchParams?.toString() ?? '';
  const urlSearch = normalizeSearch(searchParams?.get(searchName) ?? undefined);

  // The newest URL we know of, including navigations still in flight, so two quick changes
  // (a filter, then a search) build on each other instead of the stale render's params.
  const latest = useRef(urlKey);
  const inflight = useRef<string[]>([]);
  // Search values we sent and have not seen come back; tells our own echo from back/forward.
  const sent = useRef<(string | undefined)[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composing = useRef(false);
  const [text, setText] = useState(urlSearch ?? '');

  useEffect(() => () => clearTimeout(timer.current), []);

  // Queries we navigated to and have not seen come back. The render's URL lags behind them, so
  // an older echo must not roll `latest` back; anything else is back/forward and wins.
  useEffect(() => {
    const index = inflight.current.indexOf(urlKey);
    if (index >= 0) inflight.current.splice(0, index + 1);
    else inflight.current = [];
    latest.current = inflight.current.at(-1) ?? urlKey;
  }, [urlKey]);

  // Only a change of the search value in the URL may reseed the input, never a re-render while
  // the user types and never a filter change that leaves the search alone.
  useEffect(() => {
    const index = sent.current.indexOf(urlSearch);
    if (index >= 0) {
      sent.current.splice(0, index + 1);
      return;
    }
    // Not our echo: back/forward or a Clear link.
    sent.current = [];
    clearTimeout(timer.current);
    setText(urlSearch ?? '');
  }, [urlSearch]);

  const navigate = useCallback(
    (patch: Record<string, ParamValue>, mode: 'push' | 'replace') => {
      const href = hrefWith(pathname, new URLSearchParams(latest.current), patch);
      const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
      if (query === latest.current) return false;
      latest.current = query;
      inflight.current.push(query);
      startTransition(() => {
        if (mode === 'push') router.push(href, { scroll: false });
        else router.replace(href, { scroll: false });
      });
      return true;
    },
    [pathname, router],
  );

  const commitSearch = useCallback(
    (value: string) => {
      clearTimeout(timer.current);
      const normalized = normalizeSearch(value);
      if (navigate({ [searchName]: normalized }, 'replace')) sent.current.push(normalized);
    },
    [navigate, searchName],
  );

  const setParam = useCallback(
    (name: string, value: ParamValue) => {
      navigate({ [name]: value }, 'push');
    },
    [navigate],
  );

  const navigation = useMemo(() => ({ setParam, pending }), [setParam, pending]);

  return (
    <FilterNavigationContext.Provider value={navigation}>
      <form
        noValidate
        method="get"
        role="search"
        action={pathname}
        className={[styles.bar, className].filter(Boolean).join(' ')}
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          commitSearch(text);
        }}
      >
        {Object.entries(preserve ?? {}).map(([name, value]) =>
          value ? <input key={name} type="hidden" name={name} value={value} /> : null,
        )}
        {search && (
          <div className={styles.search}>
            <SearchInput
              name={searchName}
              value={text}
              maxLength={SEARCH_MAX_CHARS}
              aria-label={search.label}
              placeholder={search.placeholder}
              autoComplete="off"
              onChange={(event) => {
                const value = event.currentTarget.value;
                setText(value);
                clearTimeout(timer.current);
                // Wait out IME composition: half-formed characters are not a search.
                if (composing.current) return;
                timer.current = setTimeout(() => commitSearch(value), DEBOUNCE_MS);
              }}
              onCompositionStart={() => {
                composing.current = true;
                clearTimeout(timer.current);
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                const value = event.currentTarget.value;
                clearTimeout(timer.current);
                timer.current = setTimeout(() => commitSearch(value), DEBOUNCE_MS);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || !text) return;
                event.preventDefault();
                setText('');
                commitSearch('');
              }}
            />
            <span className={styles.busy} data-pending={pending || undefined} aria-hidden="true" />
          </div>
        )}
        {children && <div className={styles.controls}>{children}</div>}
      </form>
    </FilterNavigationContext.Provider>
  );
}

type ResultCountProps = {
  shown: number;
  total: number;
  /** Singular noun, such as "lead". */
  noun: string;
  plural?: string;
  className?: string;
};

const numberFormat = new Intl.NumberFormat('en-US');

/** Polite live region: screen readers hear the new count after a filter changes. */
export function ResultCount({ shown, total, noun, plural, className }: ResultCountProps) {
  const name = (count: number) => (count === 1 ? noun : (plural ?? `${noun}s`));
  const text =
    total === 0
      ? `No ${name(0)} found`
      : shown >= total
        ? `${numberFormat.format(total)} ${name(total)}`
        : `Showing ${numberFormat.format(shown)} of ${numberFormat.format(total)} ${name(total)}`;
  return (
    <p
      className={[styles.count, className].filter(Boolean).join(' ')}
      aria-live="polite"
      aria-atomic="true"
    >
      {text}
    </p>
  );
}
