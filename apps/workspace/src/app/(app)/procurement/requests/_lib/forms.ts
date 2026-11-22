import {
  CreatePurchaseRequestBodySchema,
  type CreatePurchaseRequestBody,
  type Currency,
  type PrRequestType,
} from '@bos/contracts';

/**
 * Pure helpers for the purchase request form: read what was typed, check it with the contracts'
 * schema and word every refusal for a person. The server action is the real gate; the browser's
 * checks are a courtesy. Quantities and prices stay the text the person typed: nothing here does
 * arithmetic, because every total is the server's. No server code, so a test or a Client
 * Component can import this.
 */

export type FieldErrors = Record<string, string>;

export interface LineValues {
  description: string;
  specification: string;
  requiresSerials?: boolean;
  uom: string;
  quantity: string;
  estimatedUnitPrice: string;
}

export interface PrValues {
  requestType: string;
  departmentId: string;
  costCenterId: string;
  justification: string;
  requiredBy: string;
  deliveryLocation: string;
  budgetCode: string;
  projectId: string;
  currency: string;
  isEmergency: boolean;
  emergencyReason: string;
  lines: LineValues[];
}

export const emptyLine = (): LineValues => ({
  description: '',
  specification: '',
  uom: '',
  quantity: '',
  estimatedUnitPrice: '',
});

export const EMPTY_PR_VALUES: PrValues = {
  requestType: 'goods',
  departmentId: '',
  costCenterId: '',
  justification: '',
  requiredBy: '',
  deliveryLocation: '',
  budgetCode: '',
  projectId: '',
  currency: 'NPR',
  isEmergency: false,
  emergencyReason: '',
  lines: [emptyLine()],
};

export const HEADER_FIELDS = [
  'requestType',
  'departmentId',
  'costCenterId',
  'justification',
  'requiredBy',
  'deliveryLocation',
  'budgetCode',
  'projectId',
  'currency',
  'emergencyReason',
] as const;
export const LINE_FIELDS = [
  'description',
  'specification',
  'uom',
  'quantity',
  'estimatedUnitPrice',
] as const;

const str = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

/** Reads the form: header fields by name, lines as `lines.<n>.<field>` in index order. */
export function valuesFromForm(form: FormData): PrValues {
  const indexes = new Set<number>();
  for (const name of form.keys()) {
    const m = /^lines\.(\d{1,3})\./.exec(name);
    if (m?.[1] !== undefined) indexes.add(Number(m[1]));
  }
  const lines = [...indexes]
    .sort((a, b) => a - b)
    .map((i) => {
      const line = emptyLine();
      for (const f of LINE_FIELDS) line[f] = str(form, `lines.${i}.${f}`);
      if (str(form, `lines.${i}.requiresSerials`) === 'on') line.requiresSerials = true;
      return line;
    });
  const values: PrValues = {
    ...EMPTY_PR_VALUES,
    lines,
    isEmergency: str(form, 'isEmergency') === 'on',
  };
  for (const f of HEADER_FIELDS) values[f] = str(form, f);
  return values;
}

/** A stored request as form values, for the edit screen. */
export function valuesFromDto(dto: {
  requestType: PrRequestType;
  departmentId: string;
  costCenterId: string;
  justification: string;
  requiredBy: string;
  deliveryLocation: string | null;
  budgetCode: string;
  projectId: string | null;
  currency: Currency;
  isEmergency: boolean;
  emergencyReason: string | null;
  lines: readonly {
    description: string;
    specification: string | null;
    requiresSerials?: boolean | undefined;
    uom: string;
    quantity: string;
    estimatedUnitPrice: string;
  }[];
}): PrValues {
  return {
    requestType: dto.requestType,
    departmentId: dto.departmentId,
    costCenterId: dto.costCenterId,
    justification: dto.justification,
    requiredBy: dto.requiredBy,
    deliveryLocation: dto.deliveryLocation ?? '',
    budgetCode: dto.budgetCode,
    projectId: dto.projectId ?? '',
    currency: dto.currency,
    isEmergency: dto.isEmergency,
    emergencyReason: dto.emergencyReason ?? '',
    lines:
      dto.lines.length > 0
        ? dto.lines.map((l) => ({
            description: l.description,
            specification: l.specification ?? '',
            ...(l.requiresSerials ? { requiresSerials: true } : {}),
            uom: l.uom,
            quantity: l.quantity,
            estimatedUnitPrice: l.estimatedUnitPrice,
          }))
        : [emptyLine()],
  };
}

const WORDS: Record<string, string> = {
  requestType: 'Choose goods, a service, or both.',
  departmentId: 'Select a department.',
  costCenterId: 'Choose a cost centre from the list.',
  justification: 'Say why this is needed, up to 2000 characters.',
  requiredBy: 'Choose the date it is needed by.',
  deliveryLocation: 'The delivery location can be up to 200 characters.',
  budgetCode: 'Enter the budget code, up to 64 characters.',
  projectId: 'Enter a valid project reference, or leave it blank.',
  currency: 'Choose NPR, INR or USD.',
  emergencyReason: 'Say why this emergency cannot wait. It adds a Management approval.',
  description: 'Describe what is needed, up to 500 characters.',
  specification: 'The specification can be up to 2000 characters.',
  uom: 'Enter the unit, for example pcs or kg.',
  quantity: 'Enter a quantity above zero, with up to 4 decimal places.',
  estimatedUnitPrice: 'Enter a price of 0 or more, with up to 2 decimal places.',
};

export type ParsedPr =
  { ok: true; data: CreatePurchaseRequestBody } | { ok: false; errors: FieldErrors };

const trim = (s: string): string => s.trim();

/** A number typed with a space inside (`10 50`): the schema refuses it, and the fix is to remove the space. */
const SPACED_NUMBER = /\S\s+\S/;
const NUMBER_FIELDS: ReadonlySet<string> = new Set(['quantity', 'estimatedUnitPrice']);

export function parsePrValues(input: PrValues): ParsedPr {
  const emergency = input.isEmergency === true;
  const candidate = {
    requestType: trim(input.requestType),
    departmentId: trim(input.departmentId),
    costCenterId: trim(input.costCenterId),
    justification: trim(input.justification),
    requiredBy: trim(input.requiredBy),
    ...(trim(input.deliveryLocation) !== ''
      ? { deliveryLocation: trim(input.deliveryLocation) }
      : {}),
    budgetCode: trim(input.budgetCode),
    ...(trim(input.projectId) !== '' ? { projectId: trim(input.projectId) } : {}),
    currency: trim(input.currency),
    isEmergency: emergency,
    // A reason typed before the box was unticked is never sent.
    ...(emergency && trim(input.emergencyReason) !== ''
      ? { emergencyReason: trim(input.emergencyReason) }
      : {}),
    lines: input.lines.map((l) => ({
      description: trim(l.description),
      ...(trim(l.specification) !== '' ? { specification: trim(l.specification) } : {}),
      ...(l.requiresSerials ? { requiresSerials: true } : {}),
      uom: trim(l.uom),
      quantity: trim(l.quantity),
      estimatedUnitPrice: trim(l.estimatedUnitPrice),
    })),
  };
  const parsed = CreatePurchaseRequestBodySchema.safeParse(candidate);
  if (parsed.success) return { ok: true, data: parsed.data };

  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const [head, index, field] = issue.path;
    if (head === 'lines' && index === undefined) {
      errors.lines ??= 'Add at least one line.';
    } else if (head === 'lines' && typeof index === 'number' && typeof field === 'string') {
      const typed = input.lines[index]?.[field as keyof LineValues];
      errors[`lines.${index}.${field}`] ??=
        NUMBER_FIELDS.has(field) && typeof typed === 'string' && SPACED_NUMBER.test(typed.trim())
          ? 'Remove the space inside the number.'
          : field === 'quantity' && /above zero/.test(issue.message)
            ? 'The quantity must be above zero.'
            : (WORDS[field] ?? issue.message);
    } else if (typeof head === 'string') {
      errors[head] ??= WORDS[head] ?? issue.message;
    }
  }
  if (Object.keys(errors).length === 0) errors.form = 'Check the form and try again.';
  return { ok: false, errors };
}
