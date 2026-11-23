'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { ActionMenu } from './action-menu';
import styles from './departments.module.css';
import {
  NewDepartmentDialog,
  RenameDepartmentDialog,
  RestoreDepartmentDialog,
  RetireDepartmentDialog,
  type DepartmentChoice,
  type DepartmentRecord,
  type StaffChoice,
} from './record-dialogs';
import { Tooltip } from '@/components/ui/tooltip';

type Open = null | 'rename' | 'retire' | 'restore';

const GLYPH = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

function PencilGlyph() {
  return (
    <svg {...GLYPH}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function ArchiveGlyph() {
  return (
    <svg {...GLYPH}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg {...GLYPH}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/**
 * Rename, Retire or Restore for one department, with their dialogs. `row` shows named icon buttons
 * on wide screens and a "More" menu on phones (both are rendered; CSS shows one); `header` shows
 * text buttons for the detail page.
 */
export function DepartmentActions({
  department,
  destinations,
  variant,
}: {
  department: DepartmentRecord;
  destinations: readonly DepartmentChoice[];
  variant: 'row' | 'header';
}) {
  const [open, setOpen] = useState<Open>(null);
  const active = department.status === 'active';
  const name = department.name;
  const opener = (which: Exclude<Open, null>) => () => setOpen(which);
  const dialogProps = (which: Exclude<Open, null>) => ({
    department,
    open: open === which,
    onOpenChange: (next: boolean) => setOpen(next ? which : null),
  });

  const controls =
    variant === 'header' ? (
      <>
        {active && (
          <Button variant="secondary" onClick={opener('rename')} aria-label={`Rename ${name}`}>
            Rename
          </Button>
        )}
        {active ? (
          <Button variant="secondary" onClick={opener('retire')} aria-label={`Retire ${name}`}>
            Retire
          </Button>
        ) : (
          <Button variant="secondary" onClick={opener('restore')} aria-label={`Restore ${name}`}>
            Restore
          </Button>
        )}
      </>
    ) : (
      <>
        <span className={styles.wide}>
          <span className={styles.rowActions}>
            {active && (
              <Tooltip content={`Rename ${name}`}>
                <Button
                  variant="ghost"
                  size="small"
                  className={styles.iconButton}
                  aria-label={`Rename ${name}`}
                  onClick={opener('rename')}
                >
                  <PencilGlyph />
                </Button>
              </Tooltip>
            )}
            <Tooltip content={active ? `Retire ${name}` : `Restore ${name}`}>
              <Button
                variant="ghost"
                size="small"
                className={styles.iconButton}
                aria-label={active ? `Retire ${name}` : `Restore ${name}`}
                onClick={opener(active ? 'retire' : 'restore')}
              >
                {active ? <ArchiveGlyph /> : <RestoreGlyph />}
              </Button>
            </Tooltip>
          </span>
        </span>
        <span className={styles.narrow}>
          <ActionMenu
            label={`More actions for ${name}`}
            items={
              active
                ? [
                    { label: `Rename ${name}`, onSelect: opener('rename') },
                    { label: `Retire ${name}`, onSelect: opener('retire') },
                  ]
                : [{ label: `Restore ${name}`, onSelect: opener('restore') }]
            }
          />
        </span>
      </>
    );

  return (
    <>
      {controls}
      {active && <RenameDepartmentDialog {...dialogProps('rename')} />}
      {active && <RetireDepartmentDialog {...dialogProps('retire')} destinations={destinations} />}
      {!active && <RestoreDepartmentDialog {...dialogProps('restore')} />}
    </>
  );
}

/** The "New department" button with its dialog. */
export function NewDepartmentButton({ staff }: { staff: readonly StaffChoice[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="large" onClick={() => setOpen(true)}>
        <span aria-hidden="true">＋</span>New department
      </Button>
      <NewDepartmentDialog staff={staff} open={open} onOpenChange={setOpen} />
    </>
  );
}
