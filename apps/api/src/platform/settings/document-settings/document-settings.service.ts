// Document settings for the quotation builder and the Settings screens (U9): the number-system display read and
// the saved term presets. No table of its own: presets are one `quotation.term_presets` settings value per
// legal entity, so every change appends a version row (audited) through SettingsService.set().
//
// A preset write is a read-modify-write of the whole list. It runs in ONE transaction and takes the settings
// advisory lock BEFORE the read (SettingsService.getLocked), so two admins saving at once queue up instead of
// the second silently overwriting the first.
import { randomUUID } from 'node:crypto';

import {
  DocumentLayoutSchema,
  HexColourSchema,
  documentSellerContact,
  type DateFormatSetting,
  type DocumentSellerContact,
  type NumberSystemsSetting,
  type Permission,
  type TermPreset,
  TermPresetKindSchema,
  TermPresetListSchema,
  TermPresetSchema,
  snapshotProfileFrom,
} from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';

import { DocumentLogoResolverFactory } from '../../../modules/images/document-logo.resolver';
import { renderQuotationHtml } from '../../../modules/quotations/render/quotation-html';
import { sampleQuotationView } from '../../../modules/quotations/render/sample-view';

import { AuthzService } from '../../authz/authz.service';
import { principal } from '../../authz/principal';
import { DB, type Db } from '../../db/db.module';
import { requestTx, withTx, type TxScope } from '../../db/tx';
import { FINANCE_SETTINGS_EDITORS } from '../settings-access';
import { SettingsService } from '../settings.service';

const TERM_PRESETS = 'quotation.term_presets';

/** Any one of these lets a caller read the presets: the quotation form, or anyone who edits them. */
export const TERM_PRESET_READERS: readonly Permission[] = [
  'quotation.draft',
  ...FINANCE_SETTINGS_EDITORS,
];

/** Any one of these lets a caller add, change or remove a preset (F1-Q48: Finance, Accountant, the admin). */
export const TERM_PRESET_WRITERS: readonly Permission[] = FINANCE_SETTINGS_EDITORS;

const CreateBody = TermPresetSchema.omit({ id: true });
const PatchBody = TermPresetSchema.pick({ name: true, body: true })
  .partial()
  .refine((b) => b.name !== undefined || b.body !== undefined, 'send name, body or both');
const ListQuery = z.object({ kind: TermPresetKindSchema.optional() });

export interface DisplaySettings {
  numberSystems: NumberSystemsSetting;
  dateFormat: DateFormatSetting;
  /** Currencies a document may use (D44): the pickers on every staff screen offer only these. */
  enabledCurrencies: string[];
  /** The four contact keys of the company profile that a printed document shows (phones, email, signatory); no tax ids or addresses beyond what screens need. */
  sellerContact: DocumentSellerContact;
}

const EMPTY_SELLER_CONTACT: DocumentSellerContact = {
  phones: [],
  email: null,
  signatoryName: null,
  signatoryTitle: null,
};

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const field = i.path.join('.');
      return field ? `${field}: ${i.message}` : i.message;
    });
    throw new BadRequestException(`Invalid ${what}: ${issues.join('; ')}`);
  }
  return parsed.data;
}

/** The same identity the list schema uses for "unique within a field", so 409 and the schema never disagree. */
const nameKey = (p: Pick<TermPreset, 'kind' | 'name'>): string =>
  `${p.kind}:${p.name.toLowerCase()}`;

function byKindThenName(a: TermPreset, b: TermPreset): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function assertNameFree(
  list: readonly TermPreset[],
  candidate: Pick<TermPreset, 'kind' | 'name'>,
  exceptId?: string,
) {
  const taken = list.some((p) => p.id !== exceptId && nameKey(p) === nameKey(candidate));
  if (taken) {
    throw new ConflictException(
      `A saved ${candidate.kind.replace(/_/g, ' ')} option named "${candidate.name}" already exists. Choose a different name.`,
    );
  }
}

const PreviewBody = z.strictObject({
  layout: DocumentLayoutSchema,
  primaryColour: HexColourSchema,
});

@Injectable()
export class DocumentSettingsService {
  private readonly logger = new Logger(DocumentSettingsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly authz: AuthzService,
    // Required, not @Optional: SettingsHttpModule imports DocumentLogoModule, and a missing wiring should fail at
    // boot rather than quietly drop the uploaded logo from the preview.
    private readonly logos: DocumentLogoResolverFactory,
  ) {}

  /** How this entity prints numbers. Any active staff user: the quotation and invoice screens all format money. */
  async display(): Promise<DisplaySettings> {
    this.assertActiveStaff();
    const { scope } = requestTx();
    const [numberSystems, dateFormat, enabledCurrencies, profile] = await Promise.all([
      this.settings.get(scope, 'format.number_systems'),
      this.settings.get(scope, 'format.date'),
      this.settings.get(scope, 'currency.enabled'),
      this.settings.get(scope, 'entity.profile'),
    ]);
    return {
      numberSystems,
      dateFormat,
      enabledCurrencies,
      // The same contact an invoice freezes at its first print, so the fallback for an unfrozen copy matches: phones in
      // print form. A profile that does not validate (a hand-edited row) gives an empty contact block rather than
      // failing the whole read, which every staff screen needs for its number, date and currency settings.
      sellerContact: documentSellerContact(profile) ?? EMPTY_SELLER_CONTACT,
    };
  }

  /**
   * A sample quotation in the chosen layout and colour, drawn by the real renderer with this entity's profile and
   * number system, so a thumbnail matches the PDF. Nothing is stored. The logo is resolved like the issuer does
   * (uploaded document, else the legacy data URL), except that a failure only drops the logo from the preview.
   */
  async previewDocument(rawBody: unknown): Promise<{ html: string }> {
    this.authz.assert('admin.settings.write');
    const body = parse(PreviewBody, rawBody, 'preview');
    const { scope } = requestTx();
    const [profile, numberSystems, dateFormat] = await Promise.all([
      this.settings.get(scope, 'entity.profile'),
      this.settings.get(scope, 'format.number_systems'),
      this.settings.get(scope, 'format.date'),
    ]);
    const logo = await this.previewLogo(scope, profile.logoDocumentId, profile.legacyLogoDataUrl);
    const html = renderQuotationHtml(sampleQuotationView(), {
      snapshot: {
        style: { layout: body.layout, primaryColour: body.primaryColour },
        profile: snapshotProfileFrom(profile, logo),
        numberSystems,
        dateFormat,
        capturedAt: new Date().toISOString(),
      },
    });
    return { html };
  }

  /**
   * The logo the preview draws: the uploaded document's clean bytes, else the legacy data URL, else none. Unlike a
   * real render (which retries), a logo not readable yet (pending scan, storage error) only leaves it out here.
   */
  private async previewLogo(
    scope: TxScope,
    logoDocumentId: string | null | undefined,
    legacyLogoDataUrl: string | null | undefined,
  ): Promise<string | null> {
    const legacy = legacyLogoDataUrl ?? null;
    // The stored JSON is read as saved: a profile saved before logoDocumentId existed has no such field.
    if (typeof logoDocumentId !== 'string') return legacy;
    try {
      return (await this.logos.forScope(scope)(logoDocumentId)) ?? legacy;
    } catch (error) {
      // Fixed words only, like the resolver's own log lines.
      const kind = error instanceof Error ? error.name : 'error';
      this.logger.warn(
        `document preview drawn without the logo: document=${logoDocumentId} kind=${kind}`,
      );
      return null;
    }
  }

  /** The saved presets, optionally of one kind, by kind then name. 403 unless staff holding a reader permission. */
  async list(rawQuery: unknown): Promise<TermPreset[]> {
    this.assertActiveStaff();
    this.assertAnyOf(TERM_PRESET_READERS);
    const { kind } = parse(ListQuery, rawQuery, 'query');
    const { scope } = requestTx();
    const list = await this.settings.get(scope, TERM_PRESETS);
    return list.filter((p) => kind === undefined || p.kind === kind).sort(byKindThenName);
  }

  async create(rawBody: unknown): Promise<TermPreset> {
    this.assertActiveStaff();
    this.assertAnyOf(TERM_PRESET_WRITERS);
    const body = parse(CreateBody, rawBody, 'term preset');
    const created: TermPreset = { id: randomUUID(), ...body };
    await this.modify((list) => {
      assertNameFree(list, created);
      return [...list, created];
    });
    return created;
  }

  async update(id: string, rawBody: unknown): Promise<TermPreset> {
    this.assertActiveStaff();
    this.assertAnyOf(TERM_PRESET_WRITERS);
    const patch = parse(PatchBody, rawBody, 'term preset');
    let result: TermPreset | undefined;
    await this.modify((list) => {
      const current = list.find((p) => p.id === id);
      if (!current) throw this.notFound(id);
      const next: TermPreset = {
        ...current,
        name: patch.name ?? current.name,
        body: patch.body ?? current.body,
      };
      result = next;
      // Nothing changed: no new version, so the history only records real edits.
      if (next.name === current.name && next.body === current.body) return null;
      assertNameFree(list, next, id);
      return list.map((p) => (p.id === id ? next : p));
    });
    return result as TermPreset;
  }

  async remove(id: string): Promise<void> {
    this.assertActiveStaff();
    this.assertAnyOf(TERM_PRESET_WRITERS);
    await this.modify((list) => {
      if (!list.some((p) => p.id === id)) throw this.notFound(id);
      return list.filter((p) => p.id !== id);
    });
  }

  /**
   * One read-modify-write: lock, read, apply `change`, validate the whole list, append the next version.
   * `change` returns the new list, or null for "nothing to write". It runs under the lock, so it sees the
   * list every earlier writer committed.
   */
  private async modify(
    change: (list: readonly TermPreset[]) => TermPreset[] | null,
  ): Promise<void> {
    const { scope, actor } = requestTx();
    await withTx(this.db, scope, actor, async (tx) => {
      const { value } = await this.settings.getLocked(tx, TERM_PRESETS);
      const next = change(value);
      if (next === null) return;
      const checked = TermPresetListSchema.safeParse(next);
      if (!checked.success) {
        const issues = checked.error.issues.map((i) => i.message).join('; ');
        throw new BadRequestException(`Invalid saved options: ${issues}`);
      }
      await this.settings.set(tx, TERM_PRESETS, checked.data);
    });
  }

  private notFound(id: string): NotFoundException {
    return new NotFoundException(`No saved option with id ${id}`);
  }

  /** Staff only: a portal caller, or a staff user who is not active, is refused before anything is read. */
  private assertActiveStaff(): void {
    const caller = principal();
    if (caller.orgKind !== 'staff' || caller.status !== 'active') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: caller.status === 'active' ? 'no_permission' : 'inactive_user',
      });
    }
  }

  /** Returns when the caller holds one of `actions`; else rethrows the refusal of the last one tried. */
  private assertAnyOf(actions: readonly Permission[]): void {
    let refusal: unknown = new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
    for (const action of actions) {
      try {
        this.authz.assert(action);
        return;
      } catch (error) {
        refusal = error;
      }
    }
    throw refusal;
  }
}
