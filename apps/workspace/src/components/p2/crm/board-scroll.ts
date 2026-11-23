/** How close to a side (px) a dragged card must be before the board scrolls that way. */
export const EDGE_ZONE = 72;
/** Fastest scroll, px per animation frame, with the pointer at the very edge. */
export const EDGE_MAX_SPEED = 18;

/**
 * Sideways scroll per frame while a card is dragged near the left or right edge of the board:
 * negative scrolls left, positive right, 0 in the middle. It ramps up with how close the pointer
 * is to the edge (quadratic, so the start is gentle) and keeps a floor of 1 px inside the zone.
 */
export function edgeScrollDelta(
  pointerX: number,
  bounds: { left: number; right: number },
  zone: number = EDGE_ZONE,
  max: number = EDGE_MAX_SPEED,
): number {
  const width = bounds.right - bounds.left;
  // A board narrower than two zones would scroll both ways at once; shrink the zone to fit.
  const edge = Math.min(zone, width / 2);
  if (edge <= 0) return 0;
  const fromLeft = pointerX - bounds.left;
  const fromRight = bounds.right - pointerX;
  if (fromLeft < edge) {
    const depth = Math.min(1, (edge - fromLeft) / edge);
    return -Math.max(1, Math.round(depth * depth * max));
  }
  if (fromRight < edge) {
    const depth = Math.min(1, (edge - fromRight) / edge);
    return Math.max(1, Math.round(depth * depth * max));
  }
  return 0;
}
