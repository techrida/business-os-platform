/**
 * The notification bell's ring and the unread dot's pop. Values were fitted frame by frame to the
 * reference video (Marcel Kargul's bell, 60 fps); method and fit errors are in
 * previews/p1-icon-motion/README.md.
 *
 * Bell: a damped spring kicked from rest, pivoting at the top of the dome (12, 2.5 on the 24 grid).
 *   zeta 0.1279, w0 15.486 rad/s (stiffness 239.8, damping 3.96, mass 1), kick 212 deg/s:
 *   +11.6, -7.8, +5.1, -3.7, +2.3, -1.5 deg about 205 ms apart.
 * Clapper: same pivot, 1.257 x the bell angle, 49.7 ms behind it.
 * Dot: scale spring from 0, zeta 0.492, w0 16.85, v0 8.33/s (peaks 1.198 at 176 ms, dips to 0.963),
 *   opacity 0 -> 1 over 173 ms. The bell is kicked 215 ms after the dot starts.
 *
 * Springs are sampled at 60 fps into linear Web Animations keyframes, so they run off the main
 * thread (transform and opacity only). A kick while the bell is still ringing adds to the current
 * motion instead of restarting it. Reduced motion: no ring, and the dot fades in.
 */

const BELL = { z: 0.1279, w0: 15.486, kick: 212, maxAmp: 13.8 };
const CLAP = { gain: 1.257, lag: 49.7 };
const DOT = { z: 0.492, w0: 16.85, v0: 8.33, fade: 173 };
/** Delay from the dot appearing to the bell's kick, as in the reference. */
export const BELL_AFTER_DOT_MS = 215;
const REST_DEG = 0.3;
const STEP = 1000 / 60;

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Closed-form damped spring: displacement and velocity t seconds after starting at (x0, v0). */
function springAt(z: number, w0: number, x0: number, v0: number, t: number): [number, number] {
  const wd = w0 * Math.sqrt(1 - z * z);
  const e = Math.exp(-z * w0 * t);
  const b = (v0 + z * w0 * x0) / wd;
  const c = Math.cos(wd * t);
  const s = Math.sin(wd * t);
  const x = e * (x0 * c + b * s);
  return [x, -z * w0 * x + e * wd * (b * c - x0 * s)];
}

interface Segment {
  t0: number;
  x0: number;
  v0: number;
}

export interface BellRing {
  /** Ring the bell `delayMs` from now. */
  kick: (delayMs?: number) => void;
  cancel: () => void;
}

export function createBellRing(swing: HTMLElement, clapper: HTMLElement): BellRing {
  let segments: Segment[] = [];
  let animations: Animation[] = [];
  let token = 0;

  const bellAt = (time: number): [number, number] => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i]!;
      if (time >= s.t0) return springAt(BELL.z, BELL.w0, s.x0, s.v0, (time - s.t0) / 1000);
    }
    return [0, 0];
  };

  const cancel = () => {
    for (const a of animations) a.cancel();
    animations = [];
    segments = [];
  };

  const kick = (delayMs = 0) => {
    if (prefersReducedMotion()) return;
    const start = performance.now();
    const t0 = start + delayMs;
    const wd = BELL.w0 * Math.sqrt(1 - BELL.z ** 2);
    const [x, v] = bellAt(t0);
    // Add the impulse to the current motion, capped so repeats never swing wider than the first peak.
    let b = (v + BELL.kick + BELL.z * BELL.w0 * x) / wd;
    const room = Math.sqrt(Math.max(0, BELL.maxAmp ** 2 - x * x));
    if (Math.abs(b) > room) b = Math.sign(b) * room;
    segments = segments.filter((s) => s.t0 < t0);
    segments.push({ t0, x0: x, v0: b * wd - BELL.z * BELL.w0 * x });

    // Stop once the envelope is under 0.3 deg, easing the last 150 ms to exactly 0.
    const envelope = Math.hypot(x, b);
    const settle =
      t0 + (1000 * Math.log(Math.max(envelope, REST_DEG) / REST_DEG)) / (BELL.z * BELL.w0);
    const fade = (time: number) => {
      const r = (settle - time) / 150;
      return r >= 1 ? 1 : r <= 0 ? 0 : r * r * (3 - 2 * r);
    };
    const duration = settle + CLAP.lag + STEP - start;
    const bellFrames: Keyframe[] = [];
    const clapFrames: Keyframe[] = [];
    for (let time = start; ; time += STEP) {
      const done = time >= start + duration;
      const at = done ? start + duration : time;
      const bell = bellAt(at)[0] * fade(at);
      const clap = CLAP.gain * bellAt(at - CLAP.lag)[0] * fade(at - CLAP.lag);
      const offset = (at - start) / duration;
      bellFrames.push({ offset, transform: `rotate(${bell.toFixed(3)}deg)` });
      // The clapper hangs inside the bell, so it rotates by its own angle minus the bell's.
      clapFrames.push({ offset, transform: `rotate(${(clap - bell).toFixed(3)}deg)` });
      if (done) break;
    }
    for (const a of animations) a.cancel();
    const mine = ++token;
    const options: KeyframeAnimationOptions = { duration, easing: 'linear' };
    animations = [swing.animate(bellFrames, options), clapper.animate(clapFrames, options)];
    animations[0]!.onfinish = () => {
      if (mine === token) segments = [];
    };
  };

  return { kick, cancel };
}

/** Pop the unread dot in from nothing. */
export function popDot(dot: HTMLElement): void {
  for (const a of dot.getAnimations()) a.cancel();
  if (prefersReducedMotion()) {
    dot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
    return;
  }
  const end = (1000 * Math.log(500)) / (DOT.z * DOT.w0);
  const frames: Keyframe[] = [];
  for (let t = 0; ; t += STEP) {
    const done = t >= end;
    const at = done ? end : t;
    const scale = done ? 1 : Math.max(0, 1 + springAt(DOT.z, DOT.w0, -1, DOT.v0, at / 1000)[0]);
    frames.push({
      offset: at / end,
      transform: `scale(${scale.toFixed(4)})`,
      opacity: Math.min(1, at / DOT.fade),
    });
    if (done) break;
  }
  dot.animate(frames, { duration: end, easing: 'linear' });
}
