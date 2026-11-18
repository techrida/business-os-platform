import type { HTMLAttributes } from 'react';

import styles from './avatar.module.css';

type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  name: string;
  size?: 'small' | 'medium' | 'large';
  shape?: 'square' | 'circle';
};

/** An initials avatar for use alongside the person's name. */
export function Avatar({
  name,
  size = 'medium',
  shape = 'square',
  className,
  ...rest
}: AvatarProps) {
  const words = name
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase())
    .join('');

  return (
    <span
      className={[styles.avatar, styles[size], styles[shape], className].filter(Boolean).join(' ')}
      aria-hidden="true"
      {...rest}
    >
      {initials || '?'}
    </span>
  );
}
