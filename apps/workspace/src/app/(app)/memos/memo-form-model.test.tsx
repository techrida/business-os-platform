import type { MemoDirectory, MemoTemplateSnapshot } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  buildPreviewTemplate,
  draftValuesOf,
  initialTemplateFields,
  parseDraftTemplate,
  restoreFromDraft,
  templateInputOf,
} from './memo-form-model';
import { MemoPaper } from './memo-paper';

const ME = '11111111-1111-4111-8111-111111111111';
const RAM = '22222222-2222-4222-8222-222222222222';
const SITA = '33333333-3333-4333-8333-333333333333';
const DEPT = '44444444-4444-4444-8444-444444444444';
const OTHER_DEPT = '55555555-5555-4555-8555-555555555555';

const person = (userId: string, name: string) => ({
  userId,
  name,
  jobTitle: null,
  department: null,
  canApprove: true,
});
const directory: MemoDirectory = {
  organizationId: '66666666-6666-4666-8666-666666666666',
  organizationName: 'Techrida Pvt. Ltd.',
  currentUserId: ME,
  departmentId: DEPT,
  departments: [
    { id: DEPT, name: 'General' },
    { id: OTHER_DEPT, name: 'Finance' },
  ],
  people: [person(ME, 'Dev Sales'), person(RAM, 'Ram Thapa'), person(SITA, 'Sita Rai')],
};
const values = { title: '', body: '' };

describe('the live paper is a function of the form values', () => {
  const fields = initialTemplateFields(null, directory, '2026-11-18');

  it('starts from the company directory: department, today, two blank signer rows that never reach the paper', () => {
    expect(fields).toMatchObject({ departmentId: DEPT, date: '2026-11-18', approvedBy: '' });
    expect(fields.recommenders).toEqual(['', '']);
    const paper = buildPreviewTemplate(directory, null, fields, ME);
    expect(paper.recommenders).toEqual([]);
    expect(paper.preparedBy.name).toBe('Dev Sales');
  });

  it('every field the person changes reaches the paper on the next render', () => {
    const changed = {
      ...fields,
      departmentId: OTHER_DEPT,
      date: '2026-12-01',
      closing: 'Please act soon.',
      recommenders: [RAM, ''],
      approvedBy: SITA,
    };
    const html = renderToStaticMarkup(
      <MemoPaper
        template={buildPreviewTemplate(directory, null, changed, ME)}
        title="Budget for November"
        body={'First paragraph\n\nSecond paragraph'}
      />,
    );
    for (const text of [
      'Finance',
      'Date: 2026-12-01',
      'Subject: Budget for November',
      'First paragraph',
      'Second paragraph',
      'Please act soon.',
      'Ram Thapa',
      'Sita Rai',
      'Dev Sales',
    ]) {
      expect(html, text).toContain(text);
    }
  });

  it('an incomplete date from the picker is shown as "Not set", not as a broken or empty line', () => {
    const html = renderToStaticMarkup(
      <MemoPaper
        template={buildPreviewTemplate(directory, null, { ...fields, date: '' }, ME)}
        title=""
        body=""
      />,
    );
    expect(html).toContain('Date: Not set');
    expect(html).toContain('Subject: Untitled memo');
  });

  it('the paper carries no developer note and keeps named signer slots', () => {
    const html = renderToStaticMarkup(
      <MemoPaper template={buildPreviewTemplate(directory, null, fields, ME)} title="x" body="y" />,
    );
    expect(html).not.toMatch(/Signatures are disabled|proposed approval route/);
    expect(html).toContain('Prepared by');
    expect(html).toContain('Approved by');
    expect(html).toContain('Not selected');
  });

  it('what is submitted has no blank rows, and the preparer is the signed-in account', () => {
    expect(
      templateInputOf({ ...fields, recommenders: ['', RAM, ''], approvedBy: SITA }, ME),
    ).toMatchObject({
      preparedByUserId: ME,
      recommenderUserIds: [RAM],
      approvedByUserId: SITA,
    });
  });
});

describe('working draft <-> form', () => {
  const fields = {
    ...initialTemplateFields(null, directory, '2026-11-18'),
    recommenders: [RAM, '', ''],
  };

  it('keeps the blank signer rows, so a restored form has the rows it had', () => {
    const draft = draftValuesOf({ ...values, title: 'Half typed' }, fields);
    const restored = restoreFromDraft(draft, directory, {
      values,
      fields: initialTemplateFields(null, directory, '2026-11-18'),
    });
    expect(restored.values.title).toBe('Half typed');
    expect(restored.fields.recommenders).toEqual([RAM, '', '']);
  });

  it('a form with no letterhead (no directory) saves only the correspondence fields plus wire defaults', () => {
    expect(draftValuesOf({ title: 't', body: 'b' }, null)).toEqual({
      title: 't',
      body: 'b',
      amount: '',
      currency: 'NPR',
    });
  });

  it('never restores the preparer from a draft', () => {
    const forged = JSON.stringify({ v: 1, preparedByUserId: RAM, preparedBy: RAM });
    const out = parseDraftTemplate(forged, directory, fields);
    expect(JSON.stringify(out)).not.toContain('prepared');
  });

  it('drops people, departments and dates that are not valid for this company, keeping the rest', () => {
    const raw = JSON.stringify({
      v: 1,
      departmentId: '99999999-9999-4999-8999-999999999999',
      date: 'next tuesday',
      closing: 'Kept',
      recommenders: [SITA, 'not-a-user', 7],
      approvedBy: '99999999-9999-4999-8999-999999999999',
    });
    expect(parseDraftTemplate(raw, directory, fields)).toEqual({
      departmentId: DEPT,
      date: '2026-11-18',
      closing: 'Kept',
      recommenders: [SITA, '', ''],
      approvedBy: '',
    });
  });

  it('ignores a template that is not JSON, and legacy money fields', () => {
    expect(parseDraftTemplate('{oops', directory, fields)).toBe(fields);
    const restored = restoreFromDraft(
      { title: 'a', body: 'b', amount: '2', currency: 'EUR' },
      directory,
      {
        values,
        fields,
      },
    );
    expect(restored.values).toEqual({ title: 'a', body: 'b' });
  });

  it('accepts a saved memo template as the starting point of an edit', () => {
    const saved: MemoTemplateSnapshot = {
      organizationId: directory.organizationId,
      organizationName: 'Techrida Pvt. Ltd.',
      departmentId: OTHER_DEPT,
      departmentName: 'Finance',
      date: '2026-10-01',
      closing: 'Thanks',
      preparedBy: person(ME, 'Dev Sales'),
      recommenders: [person(RAM, 'Ram Thapa')],
      approvedBy: person(SITA, 'Sita Rai'),
    };
    expect(initialTemplateFields(saved, directory)).toEqual({
      departmentId: OTHER_DEPT,
      date: '2026-10-01',
      closing: 'Thanks',
      recommenders: [RAM],
      approvedBy: SITA,
    });
  });
});
