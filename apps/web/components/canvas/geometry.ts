export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function center(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Where the line from the box's centre towards `toward` leaves the box. */
export function borderPoint(box: Box, toward: Point): Point {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const halfW = box.width / 2 + 2;
  const halfH = box.height / 2 + 2;
  const scale = Math.min(halfW / Math.abs(dx || 1e-9), halfH / Math.abs(dy || 1e-9));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** The visible segment of a link between two node boxes. */
export function linkSegment(source: Box, target: Box): { from: Point; to: Point } {
  return { from: borderPoint(source, center(target)), to: borderPoint(target, center(source)) };
}
