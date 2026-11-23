'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';

import { edgeScrollDelta } from './board-scroll';
import styles from './crm.module.css';
import { MarkContactedDialog } from './mark-contacted-dialog';
import { MoveForm, toastMoveResult } from './move-form';
import type { BoardCard, BoardColumnData, MoveAction } from './types';

/**
 * A stage board for leads or opportunities. Every card has a "Move" control (a native select in a
 * disclosure) that works with a keyboard and no pointer; dragging a card onto a column is a
 * shortcut that opens the same control with the stage chosen, and the person confirms with Move.
 * Columns for stages only the system sets (Won, Converted, Quotation Sent) and Lost never take a
 * drop (Lost is marked on the record page with a reason from the tenant list).
 *
 * On the lead board, a drop on Contacted, or Move with Contacted chosen, opens Mark contacted
 * instead: the API moves a lead there only with a logged call, email or meeting, so the person logs
 * it and the dialog makes the move. Cancel leaves the card where it was; the card moves only when
 * the refreshed board arrives.
 *
 * Money arrives formatted and nothing is totalled here: totals come from the server.
 */
export function Board({
  columns,
  action,
  noun,
  className,
}: {
  columns: BoardColumnData[];
  action: MoveAction;
  /** "lead" or "opportunity", for the hint and empty columns. */
  noun: string;
  className?: string | undefined;
}) {
  // A successful move re-renders the card in its new column, so the card's form unmounts with the
  // result; the board outlives it and announces the outcome when the action resolves.
  const moveAndAnnounce = useCallback<MoveAction>(
    async (prev, form) => {
      const result = await action(prev, form);
      const recordId = form.get('recordId');
      toastMoveResult(result, `board-move-${typeof recordId === 'string' ? recordId : ''}`);
      return result;
    },
    [action],
  );
  const cards = columns.flatMap((c) => c.cards);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [preset, setPreset] = useState<{ id: string; stage: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [contact, setContact] = useState<{ card: BoardCard; fromLabel: string } | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const pointerX = useRef<number | null>(null);
  const [more, setMore] = useState({ left: false, right: false });

  // Edge fades: show a side only while columns are hidden past it.
  const measure = useCallback(() => {
    const el = scroller.current;
    if (el === null) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, columns]);

  // While a card is dragged, pushing it to the left or right edge of the board scrolls the board
  // (the browser does not do this for a scroll box inside the page). The pointer position comes from
  // `dragover`, the only drag event that carries a usable one. Reduced motion keeps it: the person
  // is steering, and the scroll is instant, never smoothed.
  useEffect(() => {
    if (dragId === null) return;
    let frame = 0;
    const tick = () => {
      const el = scroller.current;
      const x = pointerX.current;
      if (el !== null && x !== null) {
        const box = el.getBoundingClientRect();
        const delta = edgeScrollDelta(x, box);
        if (delta !== 0) el.scrollLeft += delta;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      pointerX.current = null;
    };
  }, [dragId]);

  const dragged = cards.find((c) => c.id === dragId);
  const canDrop = (stage: string) =>
    stage !== 'lost' && (dragged?.moves.some((m) => m.stage === stage) ?? false);

  const asksForContact = (stage: string) => noun === 'lead' && stage === 'contacted';

  function openContact(card: BoardCard) {
    const from = columns.find((c) => c.cards.some((other) => other.id === card.id));
    const to = columns.find((c) => c.stage === 'contacted');
    setPreset(null);
    setOpenId(null);
    setContact({ card, fromLabel: from?.label ?? 'New' });
    setAnnounce(
      `Log your call, email or meeting to move ${card.title} to ${to?.label ?? 'Contacted'}.`,
    );
  }

  // A lead's Move form with Contacted chosen opens Mark contacted rather than sending a move the API
  // refuses without a logged contact. Other stages, and every opportunity move, go straight through.
  const cardAction =
    (card: BoardCard): MoveAction =>
    (prev, form) => {
      const stage = form.get('stage');
      if (typeof stage === 'string' && asksForContact(stage)) {
        openContact(card);
        return Promise.resolve(prev);
      }
      return moveAndAnnounce(prev, form);
    };

  function drop(column: BoardColumnData) {
    if (dragged === undefined || !canDrop(column.stage)) return;
    if (asksForContact(column.stage)) {
      openContact(dragged);
      return;
    }
    setPreset({ id: dragged.id, stage: column.stage });
    setOpenId(dragged.id);
    setAnnounce(`Choose Move to put ${dragged.title} in ${column.label}. On Hold needs a reason.`);
    const el = refs.current.get(dragged.id);
    requestAnimationFrame(() =>
      el?.querySelector<HTMLElement>('button[aria-haspopup="listbox"]')?.focus(),
    );
  }

  return (
    <div className={[styles.boardRoot, className].filter(Boolean).join(' ')}>
      <p className={styles.boardHint}>
        {noun === 'lead'
          ? 'Drag a card to a column, or open Move on a card to pick the stage, then confirm with Move. Moving a lead to Contacted asks you to log a call, email or meeting first.'
          : 'Drag a card to a column, or open Move on a card to pick the stage. Either way you confirm with Move.'}
      </p>
      <p className="sr-only" role="status">
        {announce}
      </p>
      <div
        className={styles.boardFrame}
        data-more-left={more.left ? 'true' : undefined}
        data-more-right={more.right ? 'true' : undefined}
      >
        <div
          ref={scroller}
          className={styles.board}
          data-dragging={dragId === null ? undefined : 'true'}
          role="region"
          aria-label={`${noun} board (scrolls sideways)`}
          tabIndex={0}
          onScroll={measure}
          onDragOver={(e) => {
            pointerX.current = e.clientX;
          }}
          onDragLeave={(e) => {
            // Left the board altogether (not just crossed into a column): stop scrolling.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) pointerX.current = null;
          }}
        >
          {columns.map((column) => {
            const headingId = `col-${column.stage}`;
            const state =
              dragId === null
                ? ''
                : canDrop(column.stage)
                  ? overStage === column.stage
                    ? styles.dropOver
                    : styles.dropAllowed
                  : styles.dropBlocked;
            return (
              <section
                key={column.stage}
                aria-labelledby={headingId}
                className={[styles.column, state].filter(Boolean).join(' ')}
                onDragOver={(e) => {
                  if (canDrop(column.stage)) {
                    e.preventDefault();
                    setOverStage(column.stage);
                  }
                }}
                onDragLeave={() => setOverStage((s) => (s === column.stage ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(column);
                  setDragId(null);
                  setOverStage(null);
                }}
              >
                <header className={styles.columnHead}>
                  <h3 id={headingId} className={styles.columnTitle}>
                    {column.label}
                  </h3>
                  <Badge tone="neutral">
                    {column.cards.length}
                    <span className="sr-only">
                      {' '}
                      {column.cards.length === 1 ? noun : `${noun}s`}
                    </span>
                  </Badge>
                </header>
                {column.note ? <p className={styles.columnNote}>{column.note}</p> : null}
                {column.cards.length === 0 ? (
                  <p className={styles.columnEmpty}>No {noun}s here.</p>
                ) : (
                  <ul className={styles.cards}>
                    {column.cards.map((card) => (
                      <BoardCardItem
                        key={card.id}
                        card={card}
                        action={cardAction(card)}
                        open={openId === card.id}
                        onToggle={(open) =>
                          setOpenId(open ? card.id : (id) => (id === card.id ? null : id))
                        }
                        presetStage={preset?.id === card.id ? preset.stage : undefined}
                        dragging={dragId === card.id}
                        onDragStart={() => {
                          setDragId(card.id);
                          setPreset(null);
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setOverStage(null);
                        }}
                        register={(el) => {
                          if (el) refs.current.set(card.id, el);
                          else refs.current.delete(card.id);
                        }}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
      {contact !== null ? (
        <MarkContactedDialog
          key={contact.card.id}
          action={action}
          id={contact.card.id}
          number={contact.card.number}
          version={contact.card.version}
          fromLabel={contact.fromLabel}
          open
          onOpenChange={(open) => {
            if (!open) setContact(null);
          }}
          onMoved={(movedTo) => setAnnounce(`${contact.card.title} moved to ${movedTo}.`)}
        />
      ) : null}
    </div>
  );
}

function BoardCardItem({
  card,
  action,
  open,
  onToggle,
  presetStage,
  dragging,
  onDragStart,
  onDragEnd,
  register,
}: {
  card: BoardCard;
  action: MoveAction;
  open: boolean;
  onToggle: (open: boolean) => void;
  presetStage: string | undefined;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  register: (el: HTMLLIElement | null) => void;
}) {
  const moves = card.moves.filter((m) => m.stage !== 'lost');
  const movable = moves.length > 0;
  return (
    <li
      ref={register}
      className={[styles.card, dragging ? styles.cardDragging : ''].filter(Boolean).join(' ')}
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <a href={card.href} className={styles.cardTitle}>
        {card.title}
      </a>
      <span className={styles.cardMeta}>{card.number}</span>
      {card.subtitle ? <span className={styles.cardSub}>{card.subtitle}</span> : null}
      {card.value !== null ? <span className={styles.cardValue}>{card.value}</span> : null}
      {movable ? (
        <details
          className={styles.cardMove}
          open={open}
          onToggle={(e) => onToggle(e.currentTarget.open)}
        >
          <summary>
            Move<span className="sr-only"> {card.title}</span>
          </summary>
          <MoveForm
            action={action}
            recordId={card.id}
            version={card.version}
            moves={moves}
            presetStage={presetStage}
            emptyText=""
            compact
            toasts={false}
          />
        </details>
      ) : null}
    </li>
  );
}
