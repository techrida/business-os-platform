'use client';

import type {
  AccessCatalogueResponse,
  AccessChange,
  AccessSettingAreaKey,
  AccessWarningCode,
} from '@bos/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/ui/dialog';

import { AreaCard } from './area-card';
import styles from './area-cards.module.css';
import {
  areaChanges,
  defaultDraft,
  isAreaEdited,
  savedDraft,
  withControlFrom,
  type AreaControl,
  type AreaDraft,
} from './by-area-model';
import type { DepartmentOption } from './hand-overs-editor';
import {
  ReviewChangesDialog,
  type ReviewCheckResult,
  type ReviewPerson,
  type ReviewPreviewResult,
  type ReviewSaveResult,
} from './review-changes-dialog';

/** The Server Actions the cards call. Passed in, so the page wires them and tests can stub them. */
export interface AreaCardsActions {
  preview: (input: { changes: AccessChange[] }) => Promise<ReviewPreviewResult>;
  save: (input: {
    changes: AccessChange[];
    expectedRevision: string;
    note: string;
    acknowledged: AccessWarningCode[];
  }) => Promise<ReviewSaveResult>;
  check: (input: { changes: AccessChange[]; person: string }) => Promise<ReviewCheckResult>;
}

export interface AreaCardsProps {
  catalogue: AccessCatalogueResponse;
  /** `admin.roles.write`: without it every control is disabled and no foot is shown. */
  canEdit: boolean;
  departments: readonly DepartmentOption[] | null;
  /** People offered by "Check a person with these changes"; empty hides that link. */
  people: readonly ReviewPerson[];
  actions: AreaCardsActions;
  /** An area to open first, from `?area=` (Check a person's "Change this" link). */
  initialAreaKey?: string | undefined;
}

interface ReviewTarget {
  key: AccessSettingAreaKey;
  changes: AccessChange[];
}

type Pending = { kind: 'open'; key: AccessSettingAreaKey | null } | { kind: 'leave'; href: string };

/**
 * Access > By area (spec 4): one card per area in the catalogue's order. One card is open at a
 * time and holds the staged values; nothing is written until the review dialog's Save changes.
 * Leaving a card, the tab or the page with unsaved edits asks first.
 */
export function AreaCards({
  catalogue,
  canEdit,
  departments,
  people,
  actions,
  initialAreaKey,
}: AreaCardsProps) {
  const router = useRouter();
  const initialArea = catalogue.areas.find((a) => a.key === initialAreaKey);
  const [openKey, setOpenKey] = useState<AccessSettingAreaKey | null>(initialArea?.key ?? null);
  const [draft, setDraft] = useState<AreaDraft | null>(() =>
    initialArea ? savedDraft(catalogue, initialArea) : null,
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [staleKey, setStaleKey] = useState<AccessSettingAreaKey | null>(null);
  // The discard question is a controlled dialog with no trigger, so it cannot return focus by
  // itself: remember what asked and focus it again when the question closes. After Discard that
  // is the toggle of the card that just opened; after Keep editing, the control that asked.
  const askedFrom = useRef<HTMLElement | null>(null);

  const areaOf = (key: AccessSettingAreaKey | null) =>
    key === null ? undefined : catalogue.areas.find((area) => area.key === key);
  const openArea = areaOf(openKey);
  const openSaved = openArea ? savedDraft(catalogue, openArea) : null;
  const staged =
    openArea && openSaved && draft ? areaChanges(catalogue, openArea, openSaved, draft) : [];
  const dirty = staged.length > 0;

  function switchTo(key: AccessSettingAreaKey | null) {
    const area = areaOf(key);
    setOpenKey(area ? area.key : null);
    setDraft(area ? savedDraft(catalogue, area) : null);
    setStaleKey(null);
  }

  function ask(next: Pending) {
    const active = document.activeElement;
    askedFrom.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setPending(next);
  }

  useEffect(() => {
    if (pending !== null) return;
    const target = askedFrom.current;
    askedFrom.current = null;
    if (target?.isConnected) target.focus();
  }, [pending]);

  function requestOpen(key: AccessSettingAreaKey | null) {
    if (dirty && key !== openKey) ask({ kind: 'open', key });
    else switchTo(key);
  }

  function discardAndContinue() {
    const next = pending;
    setPending(null);
    if (!next) return;
    if (next.kind === 'open') {
      switchTo(next.key);
      return;
    }
    if (openSaved) setDraft(openSaved);
    router.push(next.href);
  }

  // Leaving with unsaved edits: a link anywhere on the page (the tabs, the Settings menu) asks
  // first; closing or reloading the tab gets the browser's own prompt.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      if (link.target === '_blank' || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      askedFrom.current = link;
      setPending({ kind: 'leave', href: `${url.pathname}${url.search}${url.hash}` });
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);

  function undo(key: AccessSettingAreaKey, control: AreaControl) {
    const area = areaOf(key);
    if (!area) return;
    const defaults = defaultDraft(catalogue, area);
    // With unsaved edits the icon only resets that control's staged value (spec review).
    if (key === openKey && draft && dirty) {
      setDraft(withControlFrom(draft, defaults, control));
      return;
    }
    // Otherwise it opens the review dialog with that single change (spec 7.3, D32 variation).
    const saved = savedDraft(catalogue, area);
    const single = areaChanges(catalogue, area, saved, withControlFrom(saved, defaults, control));
    if (single.length > 0) setReview({ key, changes: single });
  }

  const reviewArea = review ? areaOf(review.key) : undefined;
  const pendingArea = openArea?.label ?? 'this area';

  return (
    <>
      <div className={styles.cards}>
        {catalogue.areas.map((area) => {
          const open = area.key === openKey;
          const saved = open && openSaved ? openSaved : savedDraft(catalogue, area);
          return (
            <AreaCard
              key={area.key}
              catalogue={catalogue}
              area={area}
              open={open}
              saved={saved}
              defaults={defaultDraft(catalogue, area)}
              draft={open && draft ? draft : saved}
              dirty={open && dirty}
              edited={isAreaEdited(catalogue, area)}
              canEdit={canEdit}
              stale={staleKey === area.key}
              departments={departments}
              onToggle={() => requestOpen(open ? null : area.key)}
              onDraft={(next) => {
                if (open) setDraft(next);
              }}
              onUndo={(control) => undo(area.key, control)}
              onDiscard={() => {
                if (open) setDraft(saved);
              }}
              onReview={() => {
                if (open && dirty) setReview({ key: area.key, changes: staged });
              }}
              onReload={() => router.refresh()}
            />
          );
        })}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={`Discard your changes to ${pendingArea}?`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={discardAndContinue}
      />

      <ReviewChangesDialog
        open={review !== null}
        onOpenChange={(next) => {
          if (!next) setReview(null);
        }}
        title={`Review changes to ${reviewArea?.label ?? 'access'}`}
        changes={review?.changes ?? []}
        expectedRevision={catalogue.revision}
        runPreview={(changes) => actions.preview({ changes })}
        runSave={({ acknowledged, note }) =>
          actions.save({
            changes: review?.changes ?? [],
            expectedRevision: catalogue.revision,
            acknowledged,
            note,
          })
        }
        onSaved={() => {
          switchTo(null);
          router.refresh();
        }}
        onStale={() => {
          if (!review) return;
          // The stale message sits at the card's foot, so the card opens if an undo icon of a
          // closed card started this review.
          if (review.key !== openKey) switchTo(review.key);
          setStaleKey(review.key);
        }}
        people={people}
        runCheck={people.length > 0 ? (input) => actions.check(input) : undefined}
      />
    </>
  );
}
