/**
 * Pure presentation helpers. No Solid, no OpenTUI, no OpenCode types — so this
 * module can be unit tested on its own.
 */

export const FILLED = "█"
export const EMPTY = "░"

/** A segment of the noodle bar. `color` is an opaque theme token. */
export type Segment<T> = { key: string; color: T; cells: number }

export type Bucket<T> = { key: string; color: T; value: number }

/**
 * Turn token buckets into a fixed-width run of cells.
 *
 * Each bucket's right edge is the rounded position of the *running total* of
 * values, not of the bucket on its own. Using a per-bucket position would make
 * every segment claim space from zero and overlap its neighbours.
 *
 * The edge is also never allowed to move backwards, so rounding can never hand a
 * later bucket negative cells. The segments therefore always tile the bar
 * exactly: no gaps, no overlap, and a total that never exceeds `width`. Buckets
 * narrower than one cell are dropped, because there is nothing to draw for them.
 */
export function allocateSegments<T>(buckets: Array<Bucket<T>>, denominator: number, width: number): Array<Segment<T>> {
  if (width <= 0) return []
  const scale = denominator > 0 ? denominator : 1

  const segments: Array<Segment<T>> = []
  let cursor = 0
  let running = 0

  for (const bucket of buckets) {
    if (!(bucket.value > 0)) continue
    running += bucket.value
    const edge = Math.max(cursor, Math.min(width, Math.round((running / scale) * width)))
    const cells = edge - cursor
    if (cells > 0) segments.push({ key: bucket.key, color: bucket.color, cells })
    cursor = edge
    if (cursor >= width) break
  }

  const free = width - cursor
  if (free > 0) segments.push({ key: "free", color: undefined as unknown as T, cells: free })
  return segments
}

/** Compact token counts: 934, 45.6k, 1.20M. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0"
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00"
  return money.format(value)
}

/** Render a bar back to a string. Used by tests and handy for debugging. */
export function renderBar<T>(segments: Array<Segment<T>>): string {
  return segments.map((segment) => (segment.key === "free" ? EMPTY : FILLED).repeat(segment.cells)).join("")
}
