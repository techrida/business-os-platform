// Admin routes for settings, number series and FX rates. Serves the NFR "authorization is deny-by-default":
// every route names the permission it needs, and every write goes through withTx so it is audited.
// The routes several permissions may use (F1-Q48) carry @AnyAuthenticated and check settings-access.ts first,
// before any key lookup or read: one @Can names one permission.
import {
  RateString,
  SETTINGS,
  SettingKeySchema,
  type SettingKey,
  type SettingValue,
  type SettingsPerson,
} from '@bos/contracts';
import { Dec } from '@bos/locale';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';

import { AnyAuthenticated, Can } from '../authz/decorators';
import { RoleCache } from '../authz/role-cache';
import { DB, type Db } from '../db/db.module';
import { type DbTransaction, READ_ONLY, requestTx, type TxScope, withTx } from '../db/tx';
import { assertDefaultLeadOwner, defaultLeadOwnerCandidates } from './default-lead-owner';
import { MoneyService } from './money.service';
import {
  ANY_SETTING_EDITORS,
  FINANCE_SETTINGS_EDITORS,
  FX_RATE_EDITORS,
  assertAnyOf,
  settingEditors,
} from './settings-access';
import { SettingsService } from './settings.service';

const FxCurrency = z.enum(['INR', 'USD']);
// `expectedVersion` is the optional stale-edit guard: the version the editor loaded (GET `version`), or null when
// it loaded the built-in default. Left out, the save is unconditional.
const SettingBody = z.object({
  value: z.unknown(),
  expectedVersion: z.number().int().min(1).nullable().optional(),
});
const FxRateBody = z.object({
  currency: FxCurrency,
  rateNpr: RateString.refine((v) => new Dec(v).gt(0), 'must be greater than 0'),
  rateDate: z.iso.date(),
  source: z.string().trim().min(1).max(200).default('manual'),
});
const FxRateQuery = z.object({
  currency: FxCurrency.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new BadRequestException(`Invalid ${what}: ${fields.join(', ')}`);
  }
  return parsed.data;
}

/** An unknown key is a missing resource (404), not a malformed request. Checked before the body is parsed. */
function settingKey(raw: string): SettingKey {
  const parsed = SettingKeySchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException(`Unknown setting: ${raw}`);
  return parsed.data;
}

/**
 * The key, once the caller may edit it. A caller who may edit no setting at all is refused (403) before the key is
 * looked at, so the 404 for an unknown key tells only an editor that it does not exist; then the key's own editors
 * are checked (403 for, say, Accountant asking for currency.enabled).
 */
function editableKey(raw: string): SettingKey {
  assertAnyOf(ANY_SETTING_EDITORS);
  const key = settingKey(raw);
  assertAnyOf(settingEditors(key));
  return key;
}

/**
 * The company logo is not this route's to change. `logoDocumentId`, `logoOnDarkDocumentId` and `logoOnLightDocumentId` move only through ImagesService.set (a scanned
 * upload, an `image.set` audit, the previous document removed) and `legacyLogoDataUrl` only through the legacy logo
 * migration; both write through SettingsService directly. Whatever the request holds for them is replaced by the
 * stored value, read under the setting's lock (`getLocked`), so a concurrent logo change is never reverted either.
 * A value that is not an object is passed through for the service to refuse with 400.
 */
function withStoredLogo(value: unknown, stored: SettingValue<'entity.profile'>): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const {
    logoDocumentId: _ignoredDocument,
    logoOnDarkDocumentId: _ignoredOnDark,
    logoOnLightDocumentId: _ignoredOnLight,
    legacyLogoDataUrl: _ignoredLegacy,
    ...rest
  } = value as Record<string, unknown>;
  return {
    ...rest,
    logoDocumentId: stored.logoDocumentId,
    logoOnDarkDocumentId: stored.logoOnDarkDocumentId,
    logoOnLightDocumentId: stored.logoOnLightDocumentId,
    ...(stored.legacyLogoDataUrl === undefined
      ? {}
      : { legacyLogoDataUrl: stored.legacyLogoDataUrl }),
  };
}

@Controller('v1/admin')
export class SettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly money: MoneyService,
    private readonly roleCache: RoleCache,
  ) {}

  /** The caller must hold one of settingEditors(key): the same rule as the write, so an editor can load its version. */
  @Get('settings/:key')
  @AnyAuthenticated()
  async getSetting(@Param('key') rawKey: string) {
    return this.current(editableKey(rawKey));
  }

  /**
   * The people the Settings > Sales "Lead owner" card may pick (SettingsPerson[], by name): whoever a new lead may
   * fall back to (default-lead-owner.ts). Open to exactly who may edit crm.default_lead_owner, so the card works
   * for a role without lead access (R4a Q10). Two path segments after `settings`, so `settings/:key` never takes it.
   */
  @Get('settings/crm.default_lead_owner/people')
  @AnyAuthenticated()
  async defaultLeadOwnerPeople(): Promise<SettingsPerson[]> {
    editableKey('crm.default_lead_owner');
    const { scope, actor } = requestTx();
    return withTx(
      this.db,
      scope,
      actor,
      (tx) => defaultLeadOwnerCandidates(tx, scope, this.roleCache),
      READ_ONLY,
    );
  }

  /**
   * The default reminder and escalation times, for anyone who may edit approval workflows: a new
   * workflow starts from them. Only this one key; every other setting follows settingEditors(key).
   */
  @Get('approval-sla-defaults')
  @Can('approvals.definitions.write')
  async approvalSlaDefaults() {
    return this.current('approvals.sla_defaults');
  }

  private async current(key: SettingKey) {
    const { scope } = requestTx();
    const { value, version } = await this.settings.getCurrent(scope, key);
    // version null means nobody has saved this key yet and `value` is the built-in default.
    return { key, value, version };
  }

  @Put('settings/:key')
  @AnyAuthenticated()
  async putSetting(
    @Param('key') rawKey: string,
    @Body() body: unknown,
  ): Promise<{ version: number }> {
    const key = editableKey(rawKey);
    const { value, expectedVersion } = parse(SettingBody, body, 'setting');
    const { scope, actor } = requestTx();
    // The service validates `value` against SETTINGS[key] and answers 400 when it does not fit, and 409
    // `stale_setting` when `expectedVersion` is given and is no longer the saved version.
    return withTx(this.db, scope, actor, async (tx) => {
      if (key === 'crm.default_lead_owner') await this.checkLeadOwner(tx, scope, value);
      const next =
        key === 'entity.profile'
          ? withStoredLogo(value, (await this.settings.getLocked(tx, 'entity.profile')).value)
          : value;
      return expectedVersion === undefined
        ? this.settings.set(tx, key, next)
        : this.settings.set(tx, key, next, { expectedVersion });
    });
  }

  /**
   * A person saved as the default lead owner must be one a new lead would go to (400 with
   * `details.assignmentReason` otherwise). Null (the Sales head) and a value the schema refuses pass through: the
   * service answers the latter with its own 400, before any lookup.
   */
  private async checkLeadOwner(tx: DbTransaction, scope: TxScope, value: unknown): Promise<void> {
    const parsed = SETTINGS['crm.default_lead_owner'].safeParse(value);
    if (!parsed.success || parsed.data === null) return;
    await assertDefaultLeadOwner(tx, scope, this.roleCache, parsed.data);
  }

  @Get('number-series')
  @AnyAuthenticated()
  async numberSeries() {
    assertAnyOf(FINANCE_SETTINGS_EDITORS);
    const { scope } = requestTx();
    return { items: await this.settings.listNumberSeries(scope) };
  }

  @Get('fx-rates')
  @AnyAuthenticated()
  async listFxRates(@Query() query: unknown) {
    assertAnyOf(FX_RATE_EDITORS);
    const q = parse(FxRateQuery, query, 'query');
    const { scope } = requestTx();
    return { items: await this.money.listRates(scope, q) };
  }

  @Post('fx-rates')
  @HttpCode(201)
  @AnyAuthenticated()
  async addFxRate(@Body() body: unknown): Promise<{ id: string }> {
    assertAnyOf(FX_RATE_EDITORS);
    const b = parse(FxRateBody, body, 'fx rate');
    const { scope, actor } = requestTx();
    return withTx(this.db, scope, actor, (tx) =>
      this.money.setRate(tx, b.currency, b.rateNpr, b.rateDate, b.source),
    );
  }
}
