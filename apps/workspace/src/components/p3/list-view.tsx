import { Pagination } from '@/components/ui/pagination';

export interface ListQuery {
  q?: string | string[];
  page?: string | string[];
}

export function listQuery(raw: ListQuery) {
  const q = typeof raw.q === 'string' ? raw.q.trim().slice(0, 100) : '';
  const page = typeof raw.page === 'string' && /^\d+$/.test(raw.page) ? Number(raw.page) : 1;
  return { q, page: Number.isSafeInteger(page) && page > 0 ? page : 1 };
}

export function listHref(path: string, filters: Record<string, string | undefined>, page = 1) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  if (page > 1) params.set('page', String(page));
  return params.size ? `${path}?${params}` : path;
}

export function listWindow<T>(items: T[], requestedPage: number) {
  const size = 5;
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(requestedPage, pages);
  const start = (page - 1) * size;
  const rows = items.slice(start, start + size);
  return { page, pages, start, rows };
}

export function ListFooter({
  count,
  noun,
  path,
  filters,
  window,
}: {
  count: number;
  noun: string;
  path: string;
  filters: Record<string, string | undefined>;
  window: ReturnType<typeof listWindow>;
}) {
  const { page, pages, start, rows } = window;
  const href = (n: number) => listHref(path, filters, n);
  return (
    <Pagination
      summary={`Showing ${start + 1}–${start + rows.length} of ${count} ${noun}${count === 1 ? '' : 's'}`}
      currentPage={page}
      pages={[{ page, href: href(page) }]}
      {...(page > 1 ? { previousHref: href(page - 1) } : {})}
      {...(page < pages ? { nextHref: href(page + 1) } : {})}
    />
  );
}

/** Footer of a list paged by the server: the caller builds each page's URL, so filters and rows survive. */
export function PagedFooter({
  page,
  pageCount,
  href,
}: {
  page: number;
  pageCount: number;
  href: (page: number) => string;
}) {
  return (
    <Pagination
      summary={`Page ${page} of ${pageCount}`}
      currentPage={page}
      pages={[{ page, href: href(page) }]}
      {...(page > 1 ? { previousHref: href(page - 1) } : {})}
      {...(page < pageCount ? { nextHref: href(page + 1) } : {})}
    />
  );
}
