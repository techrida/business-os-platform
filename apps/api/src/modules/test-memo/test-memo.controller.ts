// HTTP routes of the test memo. Thin on purpose: validation here, every rule in TestMemoService. Serves the
// NFR "authorization is deny-by-default": each route names its permission with @Can (route level: does the
// role hold it at all), and the service then checks the record itself with authz.assert (record level: own,
// department, ...), so a Sales user cannot read or edit a colleague's memo by guessing its id.
import {
  CreateMemoBodySchema,
  MemoListQuerySchema,
  type MemoDto,
  type MemoList,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { TestMemoService } from './test-memo.service';
import {
  SubmitMemoBodySchema,
  UpdateMemoBodySchema,
  type MemoDetailDto,
  type SubmitMemoResult,
} from './test-memo.types';

@Controller('v1/test-memos')
export class TestMemoController {
  constructor(private readonly memos: TestMemoService) {}

  /**
   * 200 with one page of the memos the caller may open, newest first. Scope comes from the caller's `memo.read`
   * grant (own, department, entity), never from the query. Pass `nextCursor` back as `cursor` for the next page.
   */
  @Get()
  @Can('memo.read')
  list(@Query() query: unknown): Promise<MemoList> {
    return this.memos.list(parseOr400(MemoListQuerySchema, query));
  }

  @Get('directory')
  @Can('memo.create')
  directory() {
    return this.memos.directory();
  }

  /** 201 with the new MemoDto (status draft, version 1, number MEMO-<fy>-NNNNN). */
  @Post()
  @Can('memo.create')
  create(@Body() body: unknown): Promise<MemoDto> {
    return this.memos.create(parseOr400(CreateMemoBodySchema, body));
  }

  /** 200 with the MemoDto plus `attachments` and `approval` (null until the memo is first submitted). */
  @Get(':id')
  @Can('memo.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<MemoDetailDto> {
    return this.memos.get(id);
  }

  /** 200 with the updated MemoDto. 404 for a record outside the caller's scope, 409 unless draft or returned. */
  @Patch(':id')
  @Can('memo.update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<MemoDto> {
    return this.memos.update(id, parseOr400(UpdateMemoBodySchema, body));
  }

  /**
   * 204 and no body: the creator discards their own draft or returned memo (soft: numbered history, audit and
   * attachment evidence stay, and nothing reads or changes it afterwards). 404 outside scope or after a discard,
   * 403 for a reader who is not the creator, 409 once the memo was submitted.
   */
  @Post(':id/discard')
  @HttpCode(204)
  @Can('memo.update')
  discard(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.memos.discard(id);
  }

  /** 200 (not 201: nothing is created at this URL) with `{ requestId, status: 'pending' | 'blocked' }`. */
  @Post(':id/submit')
  @HttpCode(200)
  @Can('memo.update')
  submit(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<SubmitMemoResult> {
    return this.memos.submit(id, parseOr400(SubmitMemoBodySchema, body ?? {}).expectedVersion);
  }
}
