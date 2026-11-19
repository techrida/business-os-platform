'use client';

import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from './colour-math';
import styles from './colour-picker.module.css';

export interface ColourPickerProps {
  /** Current colour as "#rrggbb". An unparseable value is ignored and the last good colour stays. */
  value: string;
  /** Called only with lowercase "#rrggbb", and only when the colour actually changes. */
  onChange: (hex: string) => void;
}

const FALLBACK: Hsv = { h: 0, s: 0, v: 0 };
const HEX_HINT = 'Use a hex colour such as #1d4ed8.';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const percent = (fraction: number) => Math.round(fraction * 100);

// A grey or black has no hue of its own: keep the hue the user last had so the sliders do not jump.
function fromHex(hex: string, previousHue: number): Hsv {
  const next = hexToHsv(hex);
  if (!next) return { h: previousHue, s: 0, v: 0 };
  return next.s === 0 || next.v === 0 ? { ...next, h: previousHue } : next;
}

export function ColourPicker({ value, onChange }: ColourPickerProps) {
  const hexId = useId();
  const errorId = useId();
  const dragging = useRef(false);

  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? FALLBACK);
  const [seen, setSeen] = useState(() => normalizeHex(value));
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const current = hsvToHex(hsv);

  // Follow the parent when it sets a different colour, without disturbing our own echo.
  const incoming = normalizeHex(value);
  if (incoming !== seen) {
    setSeen(incoming);
    if (incoming && incoming !== current) {
      setHsv(fromHex(incoming, hsv.h));
      setDraft(null);
      setInvalid(false);
    }
  }

  function commit(next: Hsv) {
    setHsv(next);
    setDraft(null);
    setInvalid(false);
    const hex = hsvToHex(next);
    if (hex !== current) onChange(hex);
  }

  function moveTo(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    commit({
      h: hsv.h,
      s: clamp01((event.clientX - rect.left) / rect.width),
      v: 1 - clamp01((event.clientY - rect.top) / rect.height),
    });
  }

  function onAreaPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    dragging.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is only a nicety (keeps the drag going outside the box); jsdom and a stale pointer lack it.
    }
    event.currentTarget.focus();
    moveTo(event);
  }

  function onAreaPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (dragging.current) moveTo(event);
  }

  function endDrag() {
    dragging.current = false;
  }

  function onAreaKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 10 : 1;
    let ds = 0;
    let dv = 0;
    if (event.key === 'ArrowLeft') ds = -step;
    else if (event.key === 'ArrowRight') ds = step;
    else if (event.key === 'ArrowUp') dv = step;
    else if (event.key === 'ArrowDown') dv = -step;
    else return;
    event.preventDefault();
    // Whole percent steps: after a drag the values are fractional, so snap the moved axis to the grid.
    commit({
      h: hsv.h,
      s: ds === 0 ? hsv.s : clamp01(Math.round(hsv.s * 100 + ds) / 100),
      v: dv === 0 ? hsv.v : clamp01(Math.round(hsv.v * 100 + dv) / 100),
    });
  }

  function onHueChange(event: ChangeEvent<HTMLInputElement>) {
    const h = Number(event.currentTarget.value);
    if (Number.isFinite(h)) commit({ h, s: hsv.s, v: hsv.v });
  }

  function onHexChange(event: ChangeEvent<HTMLInputElement>) {
    const text = event.currentTarget.value;
    setDraft(text);
    if (invalid && normalizeHex(text)) setInvalid(false);
  }

  function commitDraft() {
    if (draft === null) return;
    const hex = normalizeHex(draft);
    if (!hex) {
      setInvalid(true);
      return;
    }
    if (hex === current) {
      setDraft(null);
      setInvalid(false);
      return;
    }
    commit(fromHex(hex, hsv.h));
  }

  function onHexKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      // Stop a surrounding form from submitting when the user only meant to confirm the colour.
      event.preventDefault();
      commitDraft();
    } else if (event.key === 'Escape' && draft !== null) {
      setDraft(null);
      setInvalid(false);
    }
  }

  const saturation = percent(hsv.s);
  const brightness = percent(hsv.v);
  const hue = Math.round(hsv.h);
  const rootStyle = { '--hue-colour': `hsl(${hue} 100% 50%)` } as CSSProperties;

  return (
    <div className={styles.root} style={rootStyle}>
      <div
        className={styles.area}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={saturation}
        aria-valuetext={`Saturation ${saturation}%, brightness ${brightness}%`}
        onKeyDown={onAreaKeyDown}
        onPointerDown={onAreaPointerDown}
        onPointerMove={onAreaPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <span
          className={styles.areaThumb}
          aria-hidden="true"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }}
        />
      </div>

      <input
        className={styles.hue}
        type="range"
        min={0}
        max={360}
        step={1}
        value={hue}
        aria-label="Hue"
        aria-valuetext={`${hue} degrees`}
        onChange={onHueChange}
      />

      <div className={styles.hexRow}>
        <span className={styles.swatch} aria-hidden="true" style={{ background: current }} />
        <div className={styles.hexField}>
          <label className={styles.label} htmlFor={hexId}>
            Hex colour
          </label>
          <input
            id={hexId}
            className={styles.hexInput}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={draft ?? current}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            onChange={onHexChange}
            onBlur={commitDraft}
            onKeyDown={onHexKeyDown}
          />
        </div>
      </div>

      {invalid ? (
        <p id={errorId} className={styles.error} role="alert">
          {HEX_HINT}
        </p>
      ) : null}
    </div>
  );
}
