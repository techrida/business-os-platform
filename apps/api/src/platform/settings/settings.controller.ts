// Admin routes for settings, number series and FX rates. Serves the NFR "authorization is deny-by-default":
// every route names the permission it needs, and every write goes through withTx so it is audited.
import {
  RateString,
  SettingKeySchema,
  type SettingKey,
  type SettingValue,
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

import { Can } from '../authz/decorators';
import { DB, type Db } from '../db/db.module';
import { requestTx, withTx } from '../db/tx';
import { MoneyService } from './money.service';
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

/** An unknown key is a missing resource (404), not a malformed request. Checked before anything else. */
function settingKey(raw: string): SettingKey {
  const parsed = SettingKeySchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException(`Unknown setting: ${raw}`);
  return parsed.data;
}

/**
 * The company logo is not this route's to change. `logoDocumentId` moves only through ImagesService.set (a scanned
 * upload, an `image.set` audit, the previous document removed) and `legacyLogoDataUrl` only through the legacy logo
 * migration; both write through SettingsService directly. Whatever the request holds for them is replaced by the
 * stored value, read under the setting's lock (`getLocked`), so a concurrent logo change is never reverted either.
 * A value that is not an object is passed through for the service to refuse with 400.
 */
function withStoredLogo(value: unknown, stored: SettingValue<'entity.profile'>): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const {
    logoDocumentId: _ignoredDocument,
    legacyLogoDataUrl: _ignoredLegacy,
    ...rest
  } = value as Record<string, unknown>;
  return {
    ...rest,
    logoDocumentId: stored.logoDocumentId,
    ...(stored.legacyLogoDataUrl === undefined ? {} : { legacyLogoDataUrl: stored.legacyLogoDataUrl }),
  };
}

@Controller('v1/admin')
export class SettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly money: MoneyService,
  ) {}

  @Get('settings/:key')
  @Can('admin.settings.write')
  async getSetting(@Param('key') rawKey: string) {
    const key = settingKey(rawKey);
    const { scope } = requestTx();
    const { value, version } = await this.settings.getCurrent(scope, key);
    // version null means nobody has saved this key yet and `value` is the built-in default.
    return { key, value, version };
  }

  @Put('settings/:key')
  @Can('admin.settings.write')
  async putSetting(
    @Param('key') rawKey: string,
    @Body() body: unknown,
  ): Promise<{ version: number }> {
    const key = settingKey(rawKey);
    const { value, expectedVersion } = parse(SettingBody, body, 'setting');
    const { scope, actor } = requestTx();
    // The service validates `value` against SETTINGS[key] and answers 400 when it does not fit, and 409
    // `stale_setting` when `expectedVersion` is given and is no longer the saved version.
    return withTx(this.db, scope, actor, async (tx) => {
      const next =
        key === 'entity.profile'
          ? withStoredLogo(value, (await this.settings.getLocked(tx, 'entity.profile')).value)
          : value;
      return expectedVersion === undefined
        ? this.settings.set(tx, key, next)
        : this.settings.set(tx, key, next, { expectedVersion });
    });
  }

  @Get('number-series')
  @Can('admin.settings.write')
  async numberSeries() {
    const { scope } = requestTx();
    return { items: await this.settings.listNumberSeries(scope) };
  }

  @Get('fx-rates')
  @Can('admin.settings.write')
  async listFxRates(@Query() query: unknown) {
    const q = parse(FxRateQuery, query, 'query');
    const { scope } = requestTx();
    return { items: await this.money.listRates(scope, q) };
  }

  @Post('fx-rates')
  @HttpCode(201)
  @Can('admin.settings.write')
  async addFxRate(@Body() body: unknown): Promise<{ id: string }> {
    const b = parse(FxRateBody, body, 'fx rate');
    const { scope, actor } = requestTx();
    return withTx(this.db, scope, actor, (tx) =>
      this.money.setRate(tx, b.currency, b.rateNpr, b.rateDate, b.source),
    );
  }
}
