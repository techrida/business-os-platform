export { AccessSettingsModule } from './access-settings.module';
export { AccessSettingsService } from './access-settings.service';
export {
  bumpAccessRevision,
  lockAccessRevision,
  readAccessRevision,
  type AccessQueryable,
  type AccessRevisionRow,
  type BumpAccessRevisionOptions,
} from './access-revision';
export { loadAssignmentConfig, toAssignmentRuleConfig } from './assignment-config';
export { evaluateAccessChanges, effectiveScopeForUser, explainAreaAccess } from './access-evaluator';
export { buildAreaSummaries, buildAssignmentSummaries } from './access-summaries';
