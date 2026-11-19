// HTTP routes of the document settings (U9). Thin: parsing and rules live in DocumentSettingsService.
//
// - GET v1/settings/display and GET v1/term-presets carry @AnyAuthenticated, not @Can: the first is open to any
//   active staff user, the second to holders of quotation.draft OR admin.settings.write, and one @Can names one
//   permission. The service checks both before reading (same pattern as ReferenceService.listTaxCodes).
// - The three writes are @Can('admin.settings.write'), which only the Founder holds today.
import type { TermPreset } from '@bos/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';

import { AnyAuthenticated, Can } from '../../authz/decorators';
import { type DisplaySettings, DocumentSettingsService } from './document-settings.service';

@Controller('v1')
export class DocumentSettingsController {
  constructor(private readonly documentSettings: DocumentSettingsService) {}

  /** `{ numberSystem }` of the acting entity. 403 for a portal or inactive caller. */
  @Get('settings/display')
  @AnyAuthenticated()
  display(): Promise<DisplaySettings> {
    return this.documentSettings.display();
  }

  /** Bare array of presets (optionally `?kind=`), by kind then name. */
  @Get('term-presets')
  @AnyAuthenticated()
  list(@Query() query: unknown): Promise<TermPreset[]> {
    return this.documentSettings.list(query);
  }

  /** `{ html }` of a sample quotation in the given layout and colour (Settings thumbnails). */
  @Post('admin/settings/documents/preview')
  @HttpCode(200)
  @Can('admin.settings.write')
  preview(@Body() body: unknown): Promise<{ html: string }> {
    return this.documentSettings.previewDocument(body);
  }

  /** 201 with the new preset (the server generates the id). 409 when the name is taken within the kind. */
  @Post('admin/term-presets')
  @HttpCode(201)
  @Can('admin.settings.write')
  create(@Body() body: unknown): Promise<TermPreset> {
    return this.documentSettings.create(body);
  }

  /** 200 with the updated preset. 404 for an unknown id, 409 when the new name is taken within the kind. */
  @Patch('admin/term-presets/:id')
  @Can('admin.settings.write')
  update(@Param('id') id: string, @Body() body: unknown): Promise<TermPreset> {
    return this.documentSettings.update(id, body);
  }

  /** 204. 404 for an unknown id. */
  @Delete('admin/term-presets/:id')
  @HttpCode(204)
  @Can('admin.settings.write')
  remove(@Param('id') id: string): Promise<void> {
    return this.documentSettings.remove(id);
  }
}
