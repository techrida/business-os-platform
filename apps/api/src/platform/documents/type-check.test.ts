// Type check: real file-type detection on small files written to a temp dir.
// No EICAR here: this checks type spoofing, not viruses.
import { crc32 } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkType } from './type-check';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
/** "MZ" is the DOS/Windows executable header. The rest is padding. */
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);

/** A zip with stored (uncompressed) entries: enough structure for file-type's OOXML detection. */
function zip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

/** A minimal OOXML package: [Content_Types].xml naming the main part, and that part under its folder. */
function ooxml(folder: 'word' | 'xl' | 'ppt', mainPart: string, contentType: string): Buffer {
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      `<Override PartName="/${folder}/${mainPart}" ContentType="${contentType}"/></Types>`,
    [`${folder}/${mainPart}`]: '<x/>',
  });
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bos-typecheck-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function check(name: string, bytes: Buffer | string, declared: string) {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return checkType(path, Buffer.from(bytes).subarray(0, 64 * 1024), declared);
}

describe('checkType', () => {
  it('accepts a PDF declared as PDF, and a PNG declared as PNG', async () => {
    expect(await check('a.pdf', PDF, 'application/pdf')).toEqual({
      ok: true,
      detectedMime: 'application/pdf',
    });
    expect(await check('a.png', PNG, 'image/png')).toEqual({ ok: true, detectedMime: 'image/png' });
  });

  it('refuses a renamed .exe declared as PDF, and names what it found', async () => {
    const result = await check('evil.pdf', EXE, 'application/pdf');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ detectedMime: 'application/x-msdownload' });
  });

  it('refuses a PNG declared as PDF (a real file, the wrong type)', async () => {
    expect((await check('wrong.pdf', PNG, 'application/pdf')).ok).toBe(false);
  });

  it('detects docx, xlsx and pptx as their own types, not as application/zip', async () => {
    const docx = ooxml('word', 'document.xml', `${DOCX}.main+xml`);
    const xlsx = ooxml('xl', 'workbook.xml', `${XLSX}.main+xml`);
    const pptx = ooxml('ppt', 'presentation.xml', `${PPTX}.main+xml`);
    expect(await check('a.docx', docx, DOCX)).toEqual({ ok: true, detectedMime: DOCX });
    expect(await check('a.xlsx', xlsx, XLSX)).toEqual({ ok: true, detectedMime: XLSX });
    expect(await check('a.pptx', pptx, PPTX)).toEqual({ ok: true, detectedMime: PPTX });
  });

  it('refuses a spreadsheet declared as a Word file, and a plain zip declared as docx', async () => {
    const xlsx = ooxml('xl', 'workbook.xml', `${XLSX}.main+xml`);
    expect((await check('swap.docx', xlsx, DOCX)).ok).toBe(false);
    const plain = zip({ 'readme.txt': 'hello' });
    expect((await check('plain.docx', plain, DOCX)).ok).toBe(false);
  });

  it('refuses a declared type that is not on the allow-list', async () => {
    const result = await check('a.exe', EXE, 'application/x-msdownload');
    expect(result).toMatchObject({ ok: false, detectedMime: null });
  });

  describe('CSV (no magic number: negative rules)', () => {
    it('accepts plain UTF-8 text, including non-ASCII and a BOM', async () => {
      expect(await check('a.csv', 'name,amount\nSita,1250\nराम,300\n', 'text/csv')).toEqual({
        ok: true,
        detectedMime: 'text/csv',
      });
      expect(
        (
          await check(
            'bom.csv',
            Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n')]),
            'text/csv',
          )
        ).ok,
      ).toBe(true);
    });

    it('refuses content with a NUL byte in the first 64 KB', async () => {
      const result = await check('nul.csv', Buffer.from('a,b\n1,\u0000,3\n'), 'text/csv');
      expect(result.ok).toBe(false);
    });

    it('refuses invalid UTF-8, even when it is past the first 64 KB', async () => {
      expect(
        (await check('latin1.csv', Buffer.from([0x61, 0x2c, 0xe9, 0x0a]), 'text/csv')).ok,
      ).toBe(false);
      const late = Buffer.concat([
        Buffer.from('a,b\n'.repeat(20_000)),
        Buffer.from([0xff, 0xfe, 0x0a]),
      ]);
      expect(late.length).toBeGreaterThan(64 * 1024);
      expect((await check('late.csv', late, 'text/csv')).ok).toBe(false);
    });

    it('refuses a real binary file declared as CSV', async () => {
      expect((await check('png.csv', PNG, 'text/csv')).ok).toBe(false);
      expect((await check('exe.csv', EXE, 'text/csv')).ok).toBe(false);
    });

    it('refuses a text file declared as PDF', async () => {
      expect((await check('text.pdf', 'name,amount\n', 'application/pdf')).ok).toBe(false);
    });
  });
});
