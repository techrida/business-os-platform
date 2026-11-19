// The X-Total-Count header: list endpoints keep returning a bare array and say how many rows match in total
// (same scope and filters, not just this page), so the workspace can render "26-50 of 134" and a pager.
//
// Controller pattern: take the response with passthrough so Nest still serialises the return value and runs
// its interceptors and filters; without `passthrough: true` the handler would have to send the body itself.
//
//   @Get()
//   async list(@Query() query: unknown, @Res({ passthrough: true }) res: Response): Promise<LeadDto[]> {
//     const { rows, total } = await this.leads.list(parseOr400(ListLeadsQuerySchema, query));
//     setTotalCount(res, total);
//     return rows;
//   }
//
// The workspace reads it server-side (no browser CORS), so no Access-Control-Expose-Headers is needed.
export const TOTAL_COUNT_HEADER = 'X-Total-Count';

/** What setTotalCount needs from an Express response; a test passes `{ setHeader: vi.fn() }`. */
export interface HeaderTarget {
  setHeader: (name: string, value: string) => unknown;
}

export function setTotalCount(res: HeaderTarget, total: number): void {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`total must be a non-negative integer, got ${total}`);
  }
  res.setHeader(TOTAL_COUNT_HEADER, String(total));
}
