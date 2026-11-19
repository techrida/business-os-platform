export {
  ACCESS_REVISION_PORT,
  type AccessRevisionPort,
  SettingsAccessRevisionStore,
} from './access-revision.port';
export {
  applyDepartmentChanges,
  type ApplyDepartmentChangesResult,
  type DepartmentAuditAction,
  type DepartmentAuditEntryPlan,
  type DepartmentChangeFailure,
  type DepartmentChangeFailureCode,
  DepartmentChangeValidationError,
  type DepartmentPersonSnapshot,
  type DepartmentSnapshot,
  type DepartmentSnapshotRow,
  describeDepartmentChanges,
} from './department-changes';
export { DepartmentsCaller } from './departments.caller';
export { DepartmentsAdminController } from './departments.controller';
export { DepartmentsAdminModule } from './departments.module';
export { DepartmentsAdminService } from './departments.service';
