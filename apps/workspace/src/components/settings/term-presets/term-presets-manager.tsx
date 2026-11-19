'use client';

import type { TermPreset, TermPresetKind } from '@bos/contracts';
import { useState } from 'react';

import { removePresetAction } from '@/app/(app)/settings/terms/actions';
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
  firstLine,
  presetsOfKind,
  termKindLabel,
} from './term-preset-model';
import styles from './term-presets.module.css';

type Editing = { kind: TermPresetKind; preset?: TermPreset };

/**
 * The Saved terms screen: one tab per kind, each a list of saved options with edit and remove, and
 * an "Add option" button. Add and edit open one dialog; remove asks first (UIP-FEED-002). The list
 * comes from the server page, and every action revalidates it.
 */
export function TermPresetsManager({ presets }: { presets: readonly TermPreset[] }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<TermPreset | null>(null);

  return (
    <>
      <Tabs defaultSelectedKey="scope">
        <TabList aria-label="Kinds of saved text">
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
                    Add option
                  </Button>
                ) : null}
              </div>
              {items.length === 0 ? (
                <EmptyState
                  title={`No saved options for ${termKindLabel(kind)} yet`}
                  icon="bookmark"
                  headingLevel={3}
                  action={<Button onClick={add}>Add option</Button>}
                  className={styles.empty ?? ''}
                >
                  Add wording you use often, then pick it from the field on a quotation.
                </EmptyState>
              ) : (
                <ul className={styles.list} aria-label={`${termKindLabel(kind)} options`}>
                  {items.map((preset) => (
                    <li key={preset.id} className={styles.row}>
                      <div className={styles.text}>
                        <p className={styles.name}>{preset.name}</p>
                        <p className={styles.preview}>{firstLine(preset.body)}</p>
                      </div>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className={styles.iconButton}
                          aria-label={`Edit ${preset.name}`}
                          title="Edit"
                          onClick={() => setEditing({ kind, preset })}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          type="button"
                          className={`${styles.iconButton} ${styles.remove}`}
                          aria-label={`Remove ${preset.name}`}
                          title="Remove"
                          onClick={() => setRemoving(preset)}
                        >
                          <TrashIcon />
                        </button>
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
          description="It leaves the Saved options list. Quotations already written keep their text."
          confirmLabel="Remove option"
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
