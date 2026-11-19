// Side checks that are not clicks: demo files, PDF text and Mailpit lookups. None of them change
// application state.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import { abortableSleep } from './session.mjs';

// ---- demo files ------------------------------------------------------------------------------
// The demo kit (DEMO_FILES) is used when present; otherwise small, valid one-page PDFs are written
// into the run folder so the driver also works on a machine without the kit.
function tinyPdf(title) {
  const text = `BOS demo document: ${title}`.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

export function demoFile(cfg, name) {
  if (cfg.demoFilesDir) {
    const p = path.join(cfg.demoFilesDir, name);
    if (existsSync(p)) return p;
  }
  const dir = path.join(cfg.outDir, 'demo-files');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  if (!existsSync(p)) writeFileSync(p, tinyPdf(name.replace(/\.pdf$/, '')));
  return p;
}

/** Text of a PDF via pdftotext when installed; null when the tool is missing. */
export function pdfText(file) {
  try {
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', timeout: 30000 });
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function isPdf(bytes) {
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

// ---- Mailpit ---------------------------------------------------------------------------------
/**
 * GET JSON from Mailpit, verified against the stack CA only. `rejectUnauthorized` is explicit, so an
 * inherited NODE_TLS_REJECT_UNAUTHORIZED cannot turn the check off. `signal` (the step's) ends it.
 */
export function getJson(cfg, url, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const req = https.request(
      url,
      {
        ca: readFileSync(cfg.caFile),
        rejectUnauthorized: true,
        agent: false,
        headers: { accept: 'application/json' },
        signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200)
            return reject(new Error(`GET ${url} answered ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', (error) => reject(signal?.aborted ? signal.reason : error));
    req.end();
  });
}

/**
 * Newest Mailpit message matching a search (Mailpit query syntax), waiting up to `timeoutMs`.
 * Pass the step's `signal` (`s.signal`): a step that runs out of time stops polling at once.
 */
export async function findMail(cfg, query, timeoutMs = 60000, { signal } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await getJson(
      cfg,
      `${cfg.mailUrl}/api/v1/search?query=${encodeURIComponent(query)}&limit=5`,
      signal,
    );
    if (r.messages?.length) return r.messages[0];
    if (Date.now() > until) return null;
    await abortableSleep(3000, signal);
  }
}

export async function mailMessage(cfg, id, { signal } = {}) {
  return getJson(cfg, `${cfg.mailUrl}/api/v1/message/${id}`, signal);
}
