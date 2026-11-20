import { Pagination } from '@/components/ui/pagination';

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
