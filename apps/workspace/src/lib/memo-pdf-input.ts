// What the memo PDF is made from. Kept apart from the renderer (which imports pdfkit) so the browser can build
// and type this object without pulling a server library into its bundle.
import { MEMO_MAX_RECOMMENDERS, type MemoTemplateSnapshot } from '@bos/contracts';
import { z } from 'zod';

/** The text the paper shows for a signer who has not been picked yet (kept in step with MemoPaper). */
export const NOT_SELECTED = 'Not selected';
/** The note printed under the signers (kept in step with MemoPaper). */
export const PAPER_NOTE = 'Names indicate the proposed approval route. Signatures are disabled.';

const text = (max: number) => z.string().max(max);
const PersonSchema = z.object({
  name: text(200),
  jobTitle: text(200).nullable(),
});

/**
 * What the PDF needs: exactly what MemoPaper renders. The browser posts it for the unsaved form; the
 * server builds it from the stored snapshot for a saved memo. Bounded, because it is an HTTP body.
 */
export const MemoPdfInputSchema = z.object({
  organizationName: text(300),
  departmentName: text(300),
  date: text(32),
  title: text(200),
  body: text(10_000),
  closing: text(1000),
  preparedBy: PersonSchema,
  recommenders: z.array(PersonSchema).max(MEMO_MAX_RECOMMENDERS),
  approvedBy: PersonSchema,
});
export type MemoPdfInput = z.infer<typeof MemoPdfInputSchema>;

/** The paper's signer line for a snapshot person, with the same fallback the on-screen paper uses. */
const personOf = (p: { name: string; jobTitle: string | null }) => ({
  name: p.name,
  jobTitle: p.jobTitle,
});

/**
 * The PDF input of a memo template, with blank recommenders already left out. Used for both the stored snapshot of
 * a saved memo and the live values of the form, so the two exports can never drift apart.
 */
export function memoPdfInputOf(
  template: Pick<
    MemoTemplateSnapshot,
    | 'organizationName'
    | 'departmentName'
    | 'date'
    | 'closing'
    | 'preparedBy'
    | 'recommenders'
    | 'approvedBy'
  >,
  title: string,
  body: string,
): MemoPdfInput {
  return {
    organizationName: template.organizationName,
    departmentName: template.departmentName,
    date: template.date,
    title,
    body,
    closing: template.closing,
    preparedBy: personOf(template.preparedBy),
    recommenders: template.recommenders.map(personOf),
    approvedBy: personOf(template.approvedBy),
  };
}
