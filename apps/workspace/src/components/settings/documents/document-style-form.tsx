'use client';

import {
  DOCUMENT_LAYOUTS,
  DOCUMENT_LAYOUT_LABELS,
  PRESET_BRAND_COLOURS,
  contrastRatio,
  deriveBrandPalette,
  type DocumentLayout,
  type DocumentStyle,
} from '@bos/contracts';
import * as Popover from '@radix-ui/react-popover';
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import { IDLE, type ActionState } from '@/app/(app)/settings/action-state';
import type { DocumentPreviews } from '@/app/(app)/settings/documents/previews';
import { toast } from '@/components/ui/toast';
import { FormStatus } from '@/app/(app)/settings/form-status';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Panel } from '@/components/ui/panel';

import { contrastWords, normalizeHex } from './colour-math';
import { ColourPicker } from './colour-picker';
import styles from './document-style-form.module.css';
import { LayoutThumbnail } from './layout-thumbnail';
import { Tooltip } from '@/components/ui/tooltip';
import { Radio, RadioGroup } from '@/components/ui/checkbox';

export interface DocumentStyleFormProps {
  /** What is saved now. Read once; after a save the form tracks its own baseline. */
  initial: DocumentStyle;
  /** Sample quotations for every layout in `initial.primaryColour`. */
  initialPreviews: DocumentPreviews;
  saveAction: (previous: ActionState, formData: FormData) => Promise<ActionState>;
  /** The five previews in a colour; `null` when it could not be asked. */
  previewsAction: (colour: string) => Promise<DocumentPreviews | null>;
  /** Placed in the card header, for example the reset-to-default icon. */
  actions?: ReactNode;
}

const isPreset = (hex: string) => PRESET_BRAND_COLOURS.some((preset) => preset.hex === hex);

function CheckMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ExpandMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

/** The header band as the documents will print it, with its automatic text colour and the contrast it reaches. */
function ContrastStrip({ colour, hidden = false }: { colour: string; hidden?: boolean }) {
  const palette = deriveBrandPalette(colour);
  const ratio = contrastRatio(palette.onPrimary, palette.primary);
  return (
    <div
      className={styles.strip}
      style={{ background: palette.primary, color: palette.onPrimary }}
      {...(hidden ? { 'aria-hidden': true } : {})}
    >
      <span className={styles.stripLabel}>Header text</span>
      <span className={styles.stripRatio}>
        {contrastWords(ratio)}, {ratio.toFixed(1)}:1
      </span>
    </div>
  );
}

function ColourDot({
  hex,
  label,
  selected,
  onSelect,
}: {
  hex: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { onPrimary } = deriveBrandPalette(hex);
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={styles.dot}
        aria-pressed={selected}
        aria-label={`${label}, ${hex}`}
        style={{ background: hex, color: onPrimary }}
        onClick={onSelect}
      >
        {selected ? <CheckMark size={16} /> : null}
      </button>
    </Tooltip>
  );
}

/**
 * Layout and primary colour of customer documents: one decision, one Save. The layouts are the real
 * renderer's output; a colour change asks for new previews, one request at a time, and the old ones
 * stay on screen until the new ones arrive.
 */
export function DocumentStyleForm({
  initial,
  initialPreviews,
  saveAction,
  previewsAction,
  actions,
}: DocumentStyleFormProps) {
  const [saved, setSaved] = useState<DocumentStyle>(initial);
  const [layout, setLayout] = useState<DocumentLayout>(initial.layout);
  const [colour, setColour] = useState(initial.primaryColour);
  const [previews, setPreviews] = useState(initialPreviews);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [expanded, setExpanded] = useState<DocumentLayout | null>(null);

  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData): Promise<ActionState> => {
      const result = await saveAction(previous, formData);
      if (result.status === 'ok') {
        // The page re-renders and remounts this form on a saved change, which would drop the status toast.
        toast.success(result.message, { id: 'document-style-saved' });
        const savedLayout = DOCUMENT_LAYOUTS.find((value) => value === formData.get('layout'));
        const savedColour = formData.get('primaryColour');
        if (savedLayout && typeof savedColour === 'string') {
          setSaved({ layout: savedLayout, primaryColour: savedColour });
        }
      }
      return result;
    },
    IDLE,
  );

  // Previews: one request in flight, and the latest wanted colour is remembered and sent when the
  // running one finishes (Next runs server actions one after another anyway).
  const wanted = useRef(initial.primaryColour);
  const shown = useRef(initial.primaryColour);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function drain() {
    running.current = true;
    setRefreshing(true);
    try {
      while (mounted.current && shown.current !== wanted.current) {
        const target = wanted.current;
        let next: DocumentPreviews | null = null;
        try {
          next = await previewsAction(target);
        } catch {
          next = null;
        }
        if (!mounted.current) return;
        shown.current = target;
        if (next) setPreviews(next);
        setRefreshFailed(next === null);
      }
    } finally {
      running.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }

  function chooseColour(hex: string) {
    const next = normalizeHex(hex);
    if (next === null) return;
    setColour(next);
    wanted.current = next;
    if (!running.current) void drain();
  }

  const changed = layout !== saved.layout || colour !== saved.primaryColour;
  const custom = !isPreset(colour);
  const expandedLabel = expanded ? DOCUMENT_LAYOUT_LABELS[expanded] : null;

  return (
    <Panel
      title="Quotation style"
      description="Pick how your quotations are laid out and the colour they use."
      actions={actions}
    >
      <form action={formAction} className={shell.form} noValidate>
        <RadioGroup
          asChild
          name="layout"
          value={layout}
          onValueChange={(next) => setLayout(next as typeof layout)}
        >
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Layout</legend>
            <ul className={styles.layouts} aria-busy={refreshing}>
              {DOCUMENT_LAYOUTS.map((value) => {
                const { name, hint } = DOCUMENT_LAYOUT_LABELS[value];
                const selected = layout === value;
                return (
                  <li key={value} className={styles.card} data-selected={selected}>
                    <label className={styles.pick}>
                      <span className={styles.thumbWrap}>
                        <LayoutThumbnail layout={value} html={previews[value]} decorative />
                        {selected ? (
                          <span className={styles.badge} aria-hidden="true">
                            <CheckMark size={12} />
                          </span>
                        ) : null}
                      </span>
                      <span className={styles.meta}>
                        <span className={styles.nameRow}>
                          <Radio value={value} />
                          <span className={styles.name}>{name}</span>
                        </span>
                        <span className={styles.hint}>{hint}</span>
                      </span>
                    </label>
                    <button
                      type="button"
                      className={styles.expand}
                      aria-label={`Preview ${name} at full size`}
                      onClick={() => setExpanded(value)}
                    >
                      <ExpandMark />
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className={styles.status} role="status">
              {refreshing
                ? 'Updating previews…'
                : refreshFailed
                  ? 'The previews could not be refreshed, so they show the previous colour. Save still keeps the colour you chose.'
                  : ''}
            </p>
          </fieldset>
        </RadioGroup>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>Primary colour</legend>
          <input type="hidden" name="primaryColour" value={colour} />
          <div className={styles.dots}>
            {PRESET_BRAND_COLOURS.map((preset) => (
              <ColourDot
                key={preset.hex}
                hex={preset.hex}
                label={preset.name}
                selected={colour === preset.hex}
                onSelect={() => chooseColour(preset.hex)}
              />
            ))}
            <Popover.Root>
              <Popover.Trigger asChild>
                <Tooltip content="Custom colour">
                  <button
                    type="button"
                    className={`${styles.dot} ${styles.customDot}`}
                    aria-pressed={custom}
                    aria-label={custom ? `Custom colour, ${colour}` : 'Custom colour'}
                    style={{
                      ...(custom ? { '--custom-colour': colour } : {}),
                      color: custom ? deriveBrandPalette(colour).onPrimary : '#ffffff',
                    }}
                    data-custom={custom}
                  >
                    {custom ? <CheckMark size={16} /> : null}
                  </button>
                </Tooltip>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  aria-label="Custom colour"
                  align="start"
                  sideOffset={8}
                  collisionPadding={12}
                  className={styles.popover}
                >
                  <ColourPicker value={colour} onChange={chooseColour} />
                  <ContrastStrip colour={colour} hidden />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          <ContrastStrip colour={colour} />
          <p className={styles.help}>
            Used on documents your customers and vendors receive. It does not change this app&apos;s
            colours.
          </p>
        </fieldset>

        <div className={shell.foot}>
          <div className={shell.status}>
            <FormStatus state={state} pending={pending} />
          </div>
          <Button type="submit" disabled={!changed || pending}>
            Save
          </Button>
        </div>
      </form>

      {expanded && expandedLabel ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setExpanded(null);
          }}
          title={`${expandedLabel.name} layout`}
          description={expandedLabel.hint}
          size="large"
          footer={
            <Button
              disabled={layout === expanded}
              onClick={() => {
                setLayout(expanded);
                setExpanded(null);
              }}
            >
              {layout === expanded ? 'Selected' : 'Use this layout'}
            </Button>
          }
        >
          <LayoutThumbnail
            layout={expanded}
            html={previews[expanded]}
            className={styles.thumbLarge}
          />
        </Dialog>
      ) : null}
    </Panel>
  );
}
