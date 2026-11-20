'use client';

import type { SettingKey } from '@bos/contracts';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from 'react';

import { STALE_SETTING_MESSAGE } from '@/components/settings/stale-setting';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import type { SettingsSectionId } from '@/lib/settings-nav';

import {
  saveSettingsPageAction,
  type SaveSettingsPageResult,
  type SettingChangePayload,
} from './actions';
import {
  sameFieldValue,
  scheduleSummary,
  type FieldSpec,
  type SettingFieldValue,
} from './setting-fields';
import { isFieldAtDefault, parseSettingInput } from './setting-input';
import styles from './settings.module.css';
import { useUnsavedChangesGuard, type PendingLeave } from './use-unsaved-changes-guard';

export type SaveSettingsPageAction = (
  section: SettingsSectionId,
  changes: readonly SettingChangePayload[],
) => Promise<SaveSettingsPageResult>;

interface BaselineEntry {
  value: SettingFieldValue;
  version: number | null;
}

export interface SettingsFieldState {
  value: SettingFieldValue;
  dirty: boolean;
  atDefault: boolean;
  error: string | undefined;
  stale: boolean;
}

export interface SettingsFormContextValue {
  getFieldState: (spec: FieldSpec) => SettingsFieldState;
  setFieldValue: (key: SettingKey, next: SettingFieldValue) => void;
  undoField: (key: SettingKey) => void;
  resetFieldToDefault: (spec: FieldSpec) => void;
}

const SettingsFormContext = createContext<SettingsFormContextValue | null>(null);

export function useSettingsFormContext(): SettingsFormContextValue | null {
  return useContext(SettingsFormContext);
}

function buildBaselines(fields: readonly FieldSpec[]): Partial<Record<SettingKey, BaselineEntry>> {
  const entries: Partial<Record<SettingKey, BaselineEntry>> = {};
  for (const field of fields) {
    entries[field.key] = { value: field.current, version: field.version };
  }
  return entries;
}

function buildDrafts(fields: readonly FieldSpec[]): Partial<Record<SettingKey, SettingFieldValue>> {
  const entries: Partial<Record<SettingKey, SettingFieldValue>> = {};
  for (const field of fields) {
    entries[field.key] = field.current;
  }
  return entries;
}

/** Mounted only when a stale save needs a Reload button so SSR without App Router never calls useRouter. */
function StaleReloadButton() {
  const router = useRouter();
  const [reloading, startReload] = useTransition();
  return (
    <Button
      variant="secondary"
      size="small"
      disabled={reloading}
      onClick={() => startReload(() => router.refresh())}
    >
      {reloading ? 'Reloading…' : 'Reload'}
    </Button>
  );
}

/** Mounted only while a leave confirmation is open so SSR without App Router never calls useRouter. */
function LeaveConfirmDialog({
  pendingLeave,
  dirtyCount,
  hasGuardEntry,
  onCancel,
  onConfirmLeave,
}: {
  pendingLeave: PendingLeave;
  dirtyCount: number;
  hasGuardEntry: () => boolean;
  onCancel: () => void;
  onConfirmLeave: () => void;
}) {
  const router = useRouter();
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Leave without saving?"
      description={
        dirtyCount === 1
          ? 'You have 1 unsaved change on this page. Leaving will discard it.'
          : `You have ${dirtyCount} unsaved changes on this page. Leaving will discard them.`
      }
      confirmLabel="Leave without saving"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => {
        const hadGuard = hasGuardEntry();
        onConfirmLeave();
        if (pendingLeave.kind === 'href') {
          if (hadGuard && typeof router.replace === 'function') {
            router.replace(pendingLeave.href);
          } else {
            router.push(pendingLeave.href);
          }
        } else {
          window.history.go(-2);
        }
      }}
    />
  );
}

export interface SettingsFormProps {
  section: SettingsSectionId;
  /** Every SettingCard field rendered inside this page form. */
  fields: readonly FieldSpec[];
  /** Override for unit tests; defaults to `saveSettingsPageAction`. */
  saveAction?: SaveSettingsPageAction;
  children: ReactNode;
}

/**
 * Page-level form provider wrapping all SettingCards on a settings page.
 *
 * Holds typed drafts and baselines for every field, updates saved keys in place without remounting
 * cards (so unsaved edits on other fields survive partial saves and refreshes), exposes per-field
 * Undo and Reset-to-default actions, and renders one sticky Save/Discard bar plus an unsaved-leave
 * confirmation dialog.
 */
export function SettingsForm({
  section,
  fields,
  saveAction = saveSettingsPageAction,
  children,
}: SettingsFormProps) {
  const [baselines, setBaselines] = useState<Partial<Record<SettingKey, BaselineEntry>>>(() =>
    buildBaselines(fields),
  );
  const [drafts, setDrafts] = useState<Partial<Record<SettingKey, SettingFieldValue>>>(() =>
    buildDrafts(fields),
  );
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [staleKeys, setStaleKeys] = useState<SettingKey[]>([]);
  const [banner, setBanner] = useState<{ tone: 'error' | 'warning'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  // Sync fresh server props per key without wiping unsaved edits on other fields or cards.
  const [seenServer, setSeenServer] = useState<Partial<Record<SettingKey, BaselineEntry>>>(() =>
    buildBaselines(fields),
  );
  const changedFromServer = fields.filter((field) => {
    const prior = seenServer[field.key];
    return !prior || prior.version !== field.version || !sameFieldValue(prior.value, field.current);
  });
  if (changedFromServer.length > 0) {
    setSeenServer(buildBaselines(fields));
    const nextDrafts = { ...drafts };
    const nextBaselines = { ...baselines };
    for (const field of changedFromServer) {
      const currentBaseline = baselines[field.key];
      const currentDraft = drafts[field.key];
      // Keep the user's unsaved edit; only advance drafts that were clean or newly mounted.
      if (
        !currentBaseline ||
        !currentDraft ||
        sameFieldValue(currentDraft, currentBaseline.value)
      ) {
        nextDrafts[field.key] = field.current;
      }
      nextBaselines[field.key] = { value: field.current, version: field.version };
    }
    setDrafts(nextDrafts);
    setBaselines(nextBaselines);
    if (staleKeys.length > 0) {
      setStaleKeys(
        staleKeys.filter((key) => !changedFromServer.some((field) => field.key === key)),
      );
    }
  }

  const dirtyFields = useMemo(
    () =>
      fields.filter((field) => {
        const baseline = baselines[field.key]?.value ?? field.current;
        const draft = drafts[field.key] ?? field.current;
        return !sameFieldValue(draft, baseline);
      }),
    [fields, baselines, drafts],
  );
  const dirtyCount = dirtyFields.length;
  const dirty = dirtyCount > 0;

  const { pendingLeave, hasGuardEntry, cancelLeave, allowNavigation } =
    useUnsavedChangesGuard(dirty);

  const clearErrorsForKey = useCallback((key: SettingKey) => {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setStaleKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : prev));
  }, []);

  const setFieldValue = useCallback(
    (key: SettingKey, next: SettingFieldValue) => {
      setDrafts((prev) => ({ ...prev, [key]: next }));
      clearErrorsForKey(key);
      setBanner(null);
    },
    [clearErrorsForKey],
  );

  const undoField = useCallback(
    (key: SettingKey) => {
      const baseline = baselines[key];
      if (!baseline) return;
      setDrafts((prev) => ({ ...prev, [key]: baseline.value }));
      clearErrorsForKey(key);
      setBanner(null);
    },
    [baselines, clearErrorsForKey],
  );

  const resetFieldToDefault = useCallback(
    (spec: FieldSpec) => {
      setDrafts((prev) => ({ ...prev, [spec.key]: spec.defaultValue }));
      clearErrorsForKey(spec.key);
      setBanner(null);
    },
    [clearErrorsForKey],
  );

  const discardAll = useCallback(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const field of fields) {
        const baseline = baselines[field.key];
        next[field.key] = baseline ? baseline.value : field.current;
      }
      return next;
    });
    setFieldErrors({});
    setStaleKeys([]);
    setBanner(null);
  }, [fields, baselines]);

  const getFieldState = useCallback(
    (spec: FieldSpec): SettingsFieldState => {
      const baseline = baselines[spec.key]?.value ?? spec.current;
      const value = drafts[spec.key] ?? spec.current;
      const fieldDirty = !sameFieldValue(value, baseline);
      const atDefault = fieldDirty
        ? isFieldAtDefault(spec.key, value)
        : spec.isDefault && isFieldAtDefault(spec.key, value);
      return {
        value,
        dirty: fieldDirty,
        atDefault,
        error: fieldErrors[spec.key],
        stale: staleKeys.includes(spec.key),
      };
    },
    [baselines, drafts, fieldErrors, staleKeys],
  );

  const contextValue = useMemo<SettingsFormContextValue>(
    () => ({ getFieldState, setFieldValue, undoField, resetFieldToDefault }),
    [getFieldState, setFieldValue, undoField, resetFieldToDefault],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;

    // Validate every changed field before contacting the server (nothing written if any fails).
    const clientErrors: Partial<Record<SettingKey, string>> = {};
    const payload: SettingChangePayload[] = [];
    let blockedToast: string | null = null;

    for (const field of dirtyFields) {
      const value = drafts[field.key] ?? field.current;
      const parsed = parseSettingInput(field.key, value);
      if (!parsed.ok) {
        clientErrors[field.key] = parsed.message;
        if (field.key === 'sales.default_schedule' && value.kind === 'schedule') {
          const summary = scheduleSummary(value.rows);
          if (summary.status === 'short' || summary.status === 'over') {
            blockedToast = `Billing schedule must total 100%. ${summary.actionText}.`;
          }
        }
      } else {
        const baseline = baselines[field.key];
        payload.push({
          key: field.key,
          value,
          expectedVersion: baseline ? baseline.version : field.version,
        });
      }
    }

    const errorKeys = Object.keys(clientErrors) as SettingKey[];
    if (errorKeys.length > 0) {
      setFieldErrors(clientErrors);
      setBanner(null);
      const toastMessage =
        blockedToast ??
        (errorKeys.length === 1
          ? (clientErrors[errorKeys[0]!] ?? 'Check the highlighted fields and try again.')
          : 'Check the highlighted fields and try again.');
      toast.error(toastMessage, { id: 'settings-page-validation' });
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setStaleKeys([]);
    setBanner(null);

    try {
      const result = await saveAction(section, payload);

      if (result.saved.length > 0) {
        setBaselines((prev) => {
          const next = { ...prev };
          for (const entry of result.saved) {
            next[entry.key] = { value: entry.value, version: entry.version };
          }
          return next;
        });
        setDrafts((prev) => {
          const next = { ...prev };
          for (const entry of result.saved) {
            next[entry.key] = entry.value;
          }
          return next;
        });
      }

      if (result.status === 'ok') {
        setFieldErrors({});
        setStaleKeys([]);
        setBanner(null);
        toast.success(result.message, { id: 'settings-page-saved' });
      } else if (result.status === 'partial') {
        setFieldErrors(result.fieldErrors);
        setStaleKeys(result.staleKeys);
        setBanner({ tone: 'warning', message: result.message });
        toast.error(result.message, { id: 'settings-page-saved' });
      } else {
        setFieldErrors(result.fieldErrors);
        setStaleKeys(result.staleKeys);
        const hasFieldErrors = Object.keys(result.fieldErrors).length > 0;
        if (result.staleKeys.length > 0) {
          setBanner({ tone: 'warning', message: result.message || STALE_SETTING_MESSAGE });
        } else if (!hasFieldErrors) {
          setBanner({ tone: 'error', message: result.message });
        }
        toast.error(result.message, { id: 'settings-page-saved' });
      }
    } catch {
      const message = 'Could not save changes. Try again.';
      setBanner({ tone: 'error', message });
      toast.error(message, { id: 'settings-page-saved' });
    } finally {
      setSaving(false);
    }
  }

  function handleDiscardClick() {
    if (!dirty || saving) return;
    if (dirtyCount === 1) {
      discardAll();
      return;
    }
    setConfirmDiscardOpen(true);
  }

  return (
    <SettingsFormContext value={contextValue}>
      <form onSubmit={(event) => void handleSubmit(event)} className={styles.pageForm} noValidate>
        <div className={styles.column}>{children}</div>

        {banner ? (
          <Alert
            tone={banner.tone}
            role="alert"
            actions={staleKeys.length > 0 ? <StaleReloadButton /> : undefined}
          >
            {banner.message}
          </Alert>
        ) : null}

        <div className={styles.actionBar} role="region" aria-label="Settings actions">
          <p className={styles.actionMeta} role="status">
            {saving
              ? 'Saving…'
              : dirty
                ? dirtyCount === 1
                  ? '1 unsaved change'
                  : `${dirtyCount} unsaved changes`
                : 'No unsaved changes'}
          </p>
          <div className={styles.actionButtons}>
            <Button variant="secondary" disabled={!dirty || saving} onClick={handleDiscardClick}>
              Discard
            </Button>
            <Button type="submit" disabled={!dirty || saving} aria-busy={saving || undefined}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={confirmDiscardOpen}
        onOpenChange={setConfirmDiscardOpen}
        title="Discard unsaved changes?"
        description={`You have ${dirtyCount} unsaved changes. Discarding restores the last saved values.`}
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          discardAll();
        }}
      />

      {pendingLeave ? (
        <LeaveConfirmDialog
          pendingLeave={pendingLeave}
          dirtyCount={dirtyCount}
          hasGuardEntry={hasGuardEntry}
          onCancel={cancelLeave}
          onConfirmLeave={() => {
            allowNavigation();
            discardAll();
          }}
        />
      ) : null}
    </SettingsFormContext>
  );
}
