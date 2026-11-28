// Match the backend writes of each flow, not the incidental reads of the resulting page.
// Many API calls made by one Workspace request share the same Caddy correlation ID.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const actions = {
  'approve-step-1': /^\/v1\/approvals\/requests\/[^/]+\/actions$/,
  'submit-memo': /^\/v1\/test-memos\/[^/]+\/submit$/,
  'save-quotation': /^\/v1\/quotations$/,
  'issue-invoice': /^\/v1\/invoices\/[^/]+\/issue$/,
  'record-payment': /^\/v1\/payments$/,
  'submit-purchase-request': /^\/v1\/procurement\/purchase-requests\/[^/]+\/submit$/,
  'enter-vendor-bill': /^\/v1\/payables\/bills$/,
};

function* jsonLines(text) {
  for (const line of text.split('\n')) {
    try {
      yield JSON.parse(line);
    } catch {
      // Non-JSON log lines or a torn final line are not records.
    }
  }
}

const duration = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function parseTimings(text) {
  return [...jsonLines(text)].filter(
    (row) =>
      typeof row?.name === 'string' &&
      duration(row.pageMs) &&
      typeof row.ok === 'boolean' &&
      Array.isArray(row.requestIds) &&
      row.requestIds.every((id) => typeof id === 'string'),
  );
}

/** Index the API's own pino-http request completions (req.id and responseTime in milliseconds). */
export function parseApiLog(text) {
  const byId = new Map();
  for (const row of jsonLines(text)) {
    const req = row?.req;
    if (
      row?.msg !== 'request completed' ||
      !duration(row.responseTime) ||
      typeof req?.id !== 'string' ||
      req.method !== 'POST' ||
      typeof req.url !== 'string'
    )
      continue;
    const requests = byId.get(req.id) ?? [];
    requests.push({ url: req.url, ms: row.responseTime });
    byId.set(req.id, requests);
  }
  return byId;
}

/** Sum responseTime for the matched action calls in a flow. No match is unknown, not 0 ms. */
export function matchBackend(sample, byId) {
  if (!Object.hasOwn(actions, sample.name)) return null;
  const action = actions[sample.name];
  const matched = [...new Set(sample.requestIds)]
    .flatMap((id) => byId.get(id) ?? [])
    .filter((request) => action.test(request.url));
  return matched.length === 0 ? null : matched.reduce((total, request) => total + request.ms, 0);
}

export function readOptional(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const samples = parseTimings(readOptional(process.argv[2] ?? '.dev/qa-flow-timings.jsonl'));
  const log = parseApiLog(readOptional(process.argv[3] ?? '.dev/logs/api.log'));
  for (const sample of samples) {
    process.stdout.write(
      `${JSON.stringify({ ...sample, backendMs: matchBackend(sample, log) })}\n`,
    );
  }
}
