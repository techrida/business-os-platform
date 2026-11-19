// Server-safe: list pages read the URL here and the client FilterBar writes it with the same helpers.

/** Next.js `searchParams` shape, also what `readList` accepts from a plain record. */
export type RawParams = Readonly<Record<string, string | string[] | undefined>>;
type ParamSource = RawParams | { entries(): Iterable<[string, string]> };

/** Allowed values for a param: an allow-list, or a pattern for open sets such as ids. */
export type ParamRule = readonly string[] | RegExp;

export type ListSpec = {
  /** Search param name; defaults to `q`. Pass `false` for a list without search. */
  search?: string | false;
  multi?: Readonly<Record<string, ParamRule>>;
  single?: Readonly<Record<string, ParamRule>>;
  rows?: { allowed: readonly number[]; default: number };
};

export type ListState<S extends ListSpec> = {
  q: string | undefined;
  page: number;
  rows: number;
  multi: { [K in keyof NonNullable<S['multi']>]: string[] };
  single: { [K in keyof NonNullable<S['single']>]: string | undefined };
};

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const MAX_MULTI_VALUES = 20;
const MAX_VALUE_CHARS = 200;
const MAX_PAGE = 100_000;
export const DEFAULT_ROWS = { allowed: [25, 50, 100], default: 25 } as const;

function valuesOf(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function accepts(rule: ParamRule, value: string): boolean {
  if (value === '' || value.length > MAX_VALUE_CHARS) return false;
  return rule instanceof RegExp
    ? new RegExp(rule.source, rule.flags.replace('g', '')).test(value)
    : rule.includes(value);
}

/** Trim, cap, and drop terms too short to search; the API enforces the same minimum. */
export function normalizeSearch(raw: string | undefined): string | undefined {
  const text = (raw ?? '').trim().slice(0, SEARCH_MAX_CHARS).trim();
  return text.length >= SEARCH_MIN_CHARS ? text : undefined;
}

/** Parse the URL into validated values. Anything invalid is dropped rather than failing the page. */
export function readList<const S extends ListSpec>(searchParams: RawParams, spec: S): ListState<S> {
  const searchName = spec.search === undefined ? 'q' : spec.search;
  const q =
    searchName === false ? undefined : normalizeSearch(valuesOf(searchParams[searchName])[0]);

  const multi: Record<string, string[]> = {};
  for (const [name, rule] of Object.entries(spec.multi ?? {})) {
    const seen = new Set<string>();
    for (const value of valuesOf(searchParams[name])) {
      if (seen.size >= MAX_MULTI_VALUES) break;
      if (accepts(rule, value)) seen.add(value);
    }
    multi[name] = [...seen];
  }

  const single: Record<string, string | undefined> = {};
  for (const [name, rule] of Object.entries(spec.single ?? {})) {
    single[name] = valuesOf(searchParams[name]).find((value) => accepts(rule, value));
  }

  const pageText = valuesOf(searchParams.page)[0] ?? '';
  const parsedPage = /^\d{1,6}$/.test(pageText) ? Number(pageText) : 1;
  const page = Math.min(Math.max(parsedPage, 1), MAX_PAGE);

  const rowsSpec: { allowed: readonly number[]; default: number } = spec.rows ?? DEFAULT_ROWS;
  const rowsText = valuesOf(searchParams.rows)[0] ?? '';
  const parsedRows = /^\d{1,4}$/.test(rowsText) ? Number(rowsText) : undefined;
  const rows =
    parsedRows !== undefined && rowsSpec.allowed.includes(parsedRows)
      ? parsedRows
      : rowsSpec.default;

  return { q, page, rows, multi, single } as ListState<S>;
}

export type ParamPatch = Readonly<
  Record<string, string | number | readonly string[] | null | undefined>
>;

function entriesOf(source: ParamSource): [string, string][] {
  if ('entries' in source && typeof source.entries === 'function') {
    return [...(source as { entries(): Iterable<[string, string]> }).entries()];
  }
  const out: [string, string][] = [];
  for (const [key, raw] of Object.entries(source as RawParams)) {
    for (const value of valuesOf(raw)) out.push([key, value]);
  }
  return out;
}

function patchValues(value: ParamPatch[string]): string[] {
  if (value === null || value === undefined) return [];
  const list = typeof value === 'object' ? [...value] : [String(value)];
  return list.filter((item) => item !== '');
}

/**
 * Build a URL from the CURRENT params with `patch` applied, so params the caller does not own
 * (`view`, `rows`) survive. Arrays repeat the key; empty values remove it. `page` is dropped
 * unless the patch sets it, because any other change makes the old page number meaningless.
 */
export function hrefWith(pathname: string, current: ParamSource, patch: ParamPatch): string {
  const params = new Map<string, string[]>();
  for (const [key, value] of entriesOf(current)) {
    if (value === '') continue;
    params.set(key, [...(params.get(key) ?? []), value]);
  }
  if (!('page' in patch) || patchValues(patch.page).length === 0) params.delete('page');
  for (const [key, value] of Object.entries(patch)) {
    const values = patchValues(value);
    if (values.length === 0) params.delete(key);
    else params.set(key, values);
  }
  const query = new URLSearchParams();
  for (const [key, values] of params) for (const value of values) query.append(key, value);
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
}

/** Remove every filter the list owns (and the page); `rows`, `view` and the like stay. */
export function clearFiltersHref(pathname: string, current: ParamSource, spec: ListSpec): string {
  const patch: Record<string, undefined> = {};
  const searchName = spec.search === undefined ? 'q' : spec.search;
  if (searchName !== false) patch[searchName] = undefined;
  for (const name of Object.keys(spec.multi ?? {})) patch[name] = undefined;
  for (const name of Object.keys(spec.single ?? {})) patch[name] = undefined;
  return hrefWith(pathname, current, patch);
}

export type FilterDescriptor = {
  label: string;
  /** Turn a raw value (an id or key) into the text people see. */
  format?: (value: string) => string;
};

type ActiveState = {
  q?: string | undefined;
  multi: Readonly<Record<string, readonly string[]>>;
  single: Readonly<Record<string, string | undefined>>;
};

/** Names of the filters currently hiding rows, for the empty state: `Status: New, Won`. */
export function activeFilterLabels(
  state: ActiveState,
  descriptors: Readonly<Record<string, FilterDescriptor>> = {},
  searchLabel = 'Search',
): string[] {
  const labels: string[] = [];
  if (state.q) labels.push(`${searchLabel} “${state.q}”`);
  const describe = (name: string, values: readonly string[]) => {
    if (values.length === 0) return;
    const descriptor = descriptors[name];
    const shown = values.map((value) => descriptor?.format?.(value) ?? value);
    labels.push(`${descriptor?.label ?? name}: ${shown.join(', ')}`);
  };
  for (const [name, values] of Object.entries(state.multi)) describe(name, values);
  for (const [name, value] of Object.entries(state.single)) {
    if (value !== undefined) describe(name, [value]);
  }
  return labels;
}
