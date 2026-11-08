// PLACEHOLDER: only the signatures the controller codes against. The real DraftingService is built in another
// worktree (P2 unit Q1b-B part 3); the lead replaces this file with it in the merge. Do not add logic here.
import {
  type CreateQuotationBody,
  type QuotationDetail,
  type QuotationDto,
  type QuotationListItem,
  type QuotationStatus,
  type QuotationVersionDto,
  type UpdateQuotationDraftBody,
} from '@bos/contracts';
import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class DraftingService {
  create(_body: CreateQuotationBody, _idempotencyKey: string): Promise<QuotationDto> {
    return Promise.reject(new NotImplementedException('DraftingService is a placeholder'));
  }

  list(_status?: QuotationStatus): Promise<QuotationListItem[]> {
    return Promise.reject(new NotImplementedException('DraftingService is a placeholder'));
  }

  detail(_id: string): Promise<QuotationDetail> {
    return Promise.reject(new NotImplementedException('DraftingService is a placeholder'));
  }

  getVersion(_id: string, _versionId: string): Promise<QuotationVersionDto> {
    return Promise.reject(new NotImplementedException('DraftingService is a placeholder'));
  }

  updateDraft(
    _id: string,
    _versionId: string,
    _body: UpdateQuotationDraftBody,
  ): Promise<{ version: number }> {
    return Promise.reject(new NotImplementedException('DraftingService is a placeholder'));
  }
}
