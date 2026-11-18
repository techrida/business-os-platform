import type { SVGProps } from 'react';

/**
 * Inline icons from the Figma "Business OS v2" login frames. They keep the Figma viewBox and default
 * size, draw in `currentColor` (set the colour with CSS) and are decorative (`aria-hidden`).
 * Pass `width`/`height` to resize; the viewBox scales the drawing.
 */
export type IconProps = SVGProps<SVGSVGElement>;

const base = (width: number, height: number, props: IconProps): IconProps => ({
  width,
  height,
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: false,
  ...props,
});

const EYE_PATH =
  'M1.71833 10.29C1.64888 10.1029 1.64888 9.8971 1.71833 9.71C2.39475 8.06988 3.54293 6.66753 5.01731 5.68075C6.49169 4.69396 8.22587 4.16718 10 4.16718C11.7741 4.16718 13.5083 4.69396 14.9827 5.68075C16.4571 6.66753 17.6052 8.06988 18.2817 9.71C18.3511 9.8971 18.3511 10.1029 18.2817 10.29C17.6052 11.9301 16.4571 13.3325 14.9827 14.3193C13.5083 15.306 11.7741 15.8328 10 15.8328C8.22587 15.8328 6.49169 15.306 5.01731 14.3193C3.54293 13.3325 2.39475 11.9301 1.71833 10.29ZM12.5 10C12.5 11.3807 11.3807 12.5 10 12.5C8.61929 12.5 7.5 11.3807 7.5 10C7.5 8.61929 8.61929 7.5 10 7.5C11.3807 7.5 12.5 8.61929 12.5 10Z';

const strokeProps = {
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function EyeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" {...base(20, 20, props)}>
      <path d={EYE_PATH} strokeWidth={2} {...strokeProps} />
    </svg>
  );
}

/** The eye with a diagonal slash: "password is visible, click to hide". */
export function EyeOffIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" {...base(20, 20, props)}>
      <path d={EYE_PATH} strokeWidth={2} {...strokeProps} />
      <path d="M3.5 3.5L16.5 16.5" strokeWidth={2} {...strokeProps} />
    </svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 15 17" {...base(15, 17, props)}>
      <path
        d="M6.75 13.25H8.25V8.75H6.75V13.25M7.5 7.25C7.7125 7.25 7.89062 7.17813 8.03438 7.03438C8.17813 6.89062 8.25 6.7125 8.25 6.5C8.25 6.2875 8.17813 6.10938 8.03438 5.96563C7.89062 5.82188 7.7125 5.75 7.5 5.75C7.2875 5.75 7.10938 5.82188 6.96562 5.96563C6.82187 6.10938 6.75 6.2875 6.75 6.5C6.75 6.7125 6.82187 6.89062 6.96562 7.03438C7.10938 7.17813 7.2875 7.25 7.5 7.25M7.5 17C6.4625 17 5.4875 16.8031 4.575 16.4094C3.6625 16.0156 2.86875 15.4812 2.19375 14.8062C1.51875 14.1312 0.984375 13.3375 0.590625 12.425C0.196875 11.5125 0 10.5375 0 9.5C0 8.4625 0.196875 7.4875 0.590625 6.575C0.984375 5.6625 1.51875 4.86875 2.19375 4.19375C2.86875 3.51875 3.6625 2.98438 4.575 2.59062C5.4875 2.19687 6.4625 2 7.5 2C8.5375 2 9.5125 2.19687 10.425 2.59062C11.3375 2.98438 12.1312 3.51875 12.8062 4.19375C13.4812 4.86875 14.0156 5.6625 14.4094 6.575C14.8031 7.4875 15 8.4625 15 9.5C15 10.5375 14.8031 11.5125 14.4094 12.425C14.0156 13.3375 13.4812 14.1312 12.8062 14.8062C12.1312 15.4812 11.3375 16.0156 10.425 16.4094C9.5125 16.8031 8.5375 17 7.5 17M7.5 15.5C9.175 15.5 10.5938 14.9188 11.7563 13.7563C12.9188 12.5938 13.5 11.175 13.5 9.5C13.5 7.825 12.9188 6.40625 11.7563 5.24375C10.5938 4.08125 9.175 3.5 7.5 3.5C5.825 3.5 4.40625 4.08125 3.24375 5.24375C2.08125 6.40625 1.5 7.825 1.5 9.5C1.5 11.175 2.08125 12.5938 3.24375 13.7563C4.40625 14.9188 5.825 15.5 7.5 15.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function TimerIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" {...base(16, 16, props)}>
      <path
        d="M8 4V8L10.6667 9.33333M14.6667 8C14.6667 11.6819 11.6819 14.6667 8 14.6667C4.3181 14.6667 1.33333 11.6819 1.33333 8C1.33333 4.3181 4.3181 1.33333 8 1.33333C11.6819 1.33333 14.6667 4.3181 14.6667 8Z"
        strokeWidth={2}
        {...strokeProps}
      />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 32 32" {...base(32, 32, props)}>
      <path
        d="M16 7.99936V16H21.3338M29.3344 16C29.3344 23.3644 23.3644 29.3344 16 29.3344C8.63561 29.3344 2.6656 23.3644 2.6656 16C2.6656 8.63561 8.63561 2.6656 16 2.6656C23.3644 2.6656 29.3344 8.63561 29.3344 16Z"
        strokeWidth={2}
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" {...base(20, 20, props)}>
      <path
        d="M13.3328 7.4997L8.74965 12.0828L6.6664 9.9996M18.3326 9.9996C18.3326 14.6018 14.6018 18.3326 9.9996 18.3326C5.39741 18.3326 1.6666 14.6018 1.6666 9.9996C1.6666 5.39741 5.39741 1.6666 9.9996 1.6666C14.6018 1.6666 18.3326 5.39741 18.3326 9.9996Z"
        strokeWidth={1.6666}
        {...strokeProps}
      />
    </svg>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" {...base(20, 20, props)}>
      <path
        d="M18.334 5.83375L10.8409 10.6058C10.5866 10.7534 10.2978 10.8312 10.0038 10.8312C9.7097 10.8312 9.42087 10.7534 9.1666 10.6058L1.666 5.83375M3.3328 3.334H16.6672C17.5877 3.334 18.334 4.08012 18.334 5.0005V14.9995C18.334 15.9199 17.5877 16.666 16.6672 16.666H3.3328C2.41225 16.666 1.666 15.9199 1.666 14.9995V5.0005C1.666 4.08012 2.41225 3.334 3.3328 3.334Z"
        strokeWidth={1.6}
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Small "opens elsewhere" glyph (9px in the design) that follows links such as "Sign up". Drawn here; the
 * Figma frame used a Font Awesome glyph. */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 10 10" {...base(9, 9, props)}>
      <path
        d="M6 1h3v3M9 1L4.5 5.5M7.5 6.5V8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1H3.5"
        strokeWidth={1.2}
        {...strokeProps}
      />
    </svg>
  );
}
