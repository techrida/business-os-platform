'use client';

import type { TermPreset, TermPresetKind } from '@bos/contracts';
import { useState } from 'react';

import { removePresetAction, setDefaultPresetAction } from '@/app/(app)/settings/terms/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';

import { PencilIcon, TrashIcon } from './row-icons';
import { TermPresetDialog } from './term-preset-dialog';
import {
  TERM_KIND_HINTS,
  TERM_TAB_ORDER,
  isAppDefaultSet,
  presetsOfKind,
  previewLine,
  termKindLabel,
} from './term-preset-model';
import styles from './term-presets.module.css';
import { Tooltip } from '@/components/ui/tooltip';

type Editing = { kind: TermPresetKind; preset?: TermPreset };

/**
 * The Saved terms screen: one tab per kind, each a list of term sets (name, an "App default" label
 * for the ones the app ships, a "Default" label on the kind's default, a one-line preview) with
 * "Make default" / "Clear default", edit and remove, and an "Add term set" button. The default is what
 * a new quotation starts with (UIP-FORM-012). Add and edit open one dialog; remove asks first (UIP-FEED-002). The list comes from the
 * server page, and every action revalidates it.
 */
export function TermPresetsManager({ presets }: { presets: readonly TermPreset[] }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<TermPreset | null>(null);
  const [changingDefault, setChangingDefault] = useState<string | null>(null);

  async function chooseDefault(preset: TermPreset) {
    if (changingDefault !== null) return;
    setChangingDefault(preset.id);
    try {
      const result = await setDefaultPresetAction(preset.id, preset.isDefault !== true);
      if (result.status === 'ok') toast.success(result.message);
      else toast.error(result.message);
    } catch {
      toast.error('The platform did not answer. Check your connection and try again.');
    } finally {
      setChangingDefault(null);
    }
  }

  return (
    <>
      <Tabs defaultSelectedKey="scope">
        <TabList aria-label="Kinds of term set">
          {TERM_TAB_ORDER.map((kind) => (
            <Tab key={kind} id={kind}>
              {termKindLabel(kind)}
            </Tab>
          ))}
        </TabList>
        {TERM_TAB_ORDER.map((kind) => {
          const items = presetsOfKind(presets, kind);
          const add = () => setEditing({ kind });
          return (
            <TabPanel key={kind} id={kind}>
              <div className={styles.head}>
                <p className={styles.hint}>{TERM_KIND_HINTS[kind]}</p>
                {items.length > 0 ? (
                  <Button size="small" className={styles.addButton} onClick={add}>
                    Add term set
                  </Button>
                ) : null}
              </div>
              {items.length === 0 ? (
                <EmptyState
                  title={`No term sets for ${termKindLabel(kind)} yet`}
                  icon="bookmark"
                  headingLevel={3}
                  action={<Button onClick={add}>Add term set</Button>}
                  className={styles.empty ?? ''}
                >
                  Add wording you use often, then pick it from the field on a quotation.
                </EmptyState>
              ) : (
                <ul className={styles.list} aria-label={`${termKindLabel(kind)} term sets`}>
                  {items.map((preset) => (
                    <li key={preset.id} className={styles.row}>
                      <div className={styles.text}>
                        <div className={styles.nameLine}>
                          <p className={styles.name}>{preset.name}</p>
                          {isAppDefaultSet(preset.id) ? <Badge>App default</Badge> : null}
                          {preset.isDefault === true ? <Badge tone="info">Default</Badge> : null}
                        </div>
                        <p className={styles.preview}>{previewLine(preset.body)}</p>
                      </div>
                      <div className={styles.rowActions}>
                        {kind !== 'payment_terms' ? (
                          <Button
                            size="small"
                            variant="secondary"
                            disabled={changingDefault !== null}
                            aria-label={
                              preset.isDefault === true
                                ? `Clear default ${termKindLabel(kind)}`
                                : `Make ${preset.name} the default ${termKindLabel(kind)}`
                            }
                            onClick={() => void chooseDefault(preset)}
                          >
                            {preset.isDefault === true ? 'Clear default' : 'Make default'}
                          </Button>
                        ) : null}
                        <Tooltip content="Edit">
                          <button
                            type="button"
                            className={styles.iconButton}
                            aria-label={`Edit ${preset.name}`}
                            onClick={() => setEditing({ kind, preset })}
                          >
                            <PencilIcon />
                          </button>
                        </Tooltip>
                        <Tooltip content="Remove">
                          <button
                            type="button"
                            className={`${styles.iconButton} ${styles.remove}`}
                            aria-label={`Remove ${preset.name}`}
                            onClick={() => setRemoving(preset)}
                          >
                            <TrashIcon />
                          </button>
                        </Tooltip>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </TabPanel>
          );
        })}
      </Tabs>

      {editing ? (
        <TermPresetDialog
          key={editing.preset?.id ?? `new:${editing.kind}`}
          kind={editing.kind}
          preset={editing.preset}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          key={removing.id}
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={`Remove "${removing.name}"?`}
          description="It leaves the term sets list. Quotations already written keep their text."
          confirmLabel="Remove term set"
          destructive
          onConfirm={async () => {
            const result = await removePresetAction(removing.id);
            if (result.status === 'ok') {
              toast.success(result.message);
              return true;
            }
            toast.error(result.message);
            return false;
          }}
        />
      ) : null}
    </>
  );
}
