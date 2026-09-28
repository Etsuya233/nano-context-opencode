import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { allocateSegments, formatMoney, formatTokens, renderBar } from "./bar.ts"

const width = 20

function segments(values: Record<string, number>) {
  return allocateSegments(
    Object.entries(values).map(([key, value]) => ({ key, color: key, value })),
    1000,
    width,
  )
}

function used(segments: Array<{ cells: number }>) {
  return segments.reduce((total, segment) => total + segment.cells, 0)
}

describe("allocateSegments", () => {
  it("always tiles the bar to the full width", () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [999, 1, 0, 0],
      [250, 250, 250, 250],
      [1000, 0, 0, 0],
      [7, 13, 111, 869],
    ]
    for (const [inp, cache, think, out] of cases) {
      const allocated = segments({ in: inp, cache, think, out })
      assert.equal(used(allocated), width, `expected ${width} cells for ${inp}/${cache}/${think}/${out}`)
    }
  })

  it("does not let equal buckets overlap each other", () => {
    // Regression: computing each bucket's right edge from its own value instead
    // of the running total gives every quarter the same edge, so the first bucket
    // claimed all 5 cells and the rest collapsed to zero.
    const allocated = segments({ in: 250, cache: 250, think: 250, out: 250 })
    assert.deepEqual(
      allocated.map((s) => s.cells),
      [5, 5, 5, 5],
    )
  })

  it("allocates cells proportionally to the bucket values", () => {
    const allocated = segments({ in: 500, cache: 250, out: 250 })
    const byKey = Object.fromEntries(allocated.map((s) => [s.key, s.cells]))
    assert.equal(byKey.in, 10)
    assert.equal(byKey.cache, 5)
    assert.equal(byKey.out, 5)
    assert.equal(byKey.free, undefined)
  })

  it("adds a free segment for the unused remainder of the window", () => {
    const allocated = segments({ in: 200, cache: 300 })
    const free = allocated.find((s) => s.key === "free")
    // 200 + 300 of a 1000 window is 50%, so half the bar is free.
    assert.equal(free?.cells, width / 2)
    // `free` is always last so the meter reads left-to-right as "used, then left".
    assert.equal(allocated.at(-1)?.key, "free")
  })

  it("drops buckets that would round to zero cells", () => {
    // 1 token on top of 499 is 0.02 of a cell at width 20, so there is no room to
    // draw it. The bar must still tile the full width.
    const allocated = segments({ in: 499, think: 1 })
    assert.deepEqual(
      allocated.map((s) => s.key),
      ["in", "free"],
    )
    assert.equal(used(allocated), width)
  })

  it("clamps to the bar width when usage exceeds the denominator", () => {
    const allocated = segments({ in: 999_900, think: 40 })
    assert.deepEqual(
      allocated.map((s) => s.key),
      ["in"],
    )
    assert.equal(used(allocated), width)
  })

  it("skips empty buckets entirely", () => {
    const allocated = segments({ in: 0, cache: 0, think: 0, out: 0 })
    assert.deepEqual(
      allocated.map((s) => s.key),
      ["free"],
    )
    assert.equal(renderBar(allocated), "░".repeat(width))
  })

  it("keeps segment counts monotonic so later segments never jump backwards", () => {
    const allocated = segments({ in: 0, cache: 999, think: 1 })
    let cursor = 0
    for (const segment of allocated) {
      assert.ok(segment.cells > 0)
      cursor += segment.cells
      assert.ok(cursor <= width)
    }
  })

  it("fills the bar when usage overflows the window", () => {
    // Denominator falls back to the usage itself, so there is no free space left.
    const allocated = allocateSegments([{ key: "in", color: "in", value: 5000 }], 5000, width)
    assert.equal(used(allocated), width)
    assert.equal(allocated.some((s) => s.key === "free"), false)
  })

  it("survives a zero or negative width", () => {
    assert.deepEqual(allocateSegments([{ key: "in", color: "in", value: 1 }], 10, 0), [])
    assert.deepEqual(allocateSegments([{ key: "in", color: "in", value: 1 }], 10, -5), [])
  })
})

describe("formatTokens", () => {
  it("switches units at the right thresholds", () => {
    assert.equal(formatTokens(0), "0")
    assert.equal(formatTokens(934), "934")
    assert.equal(formatTokens(45_554), "45.6k")
    assert.equal(formatTokens(999_999), "1000.0k")
    assert.equal(formatTokens(1_200_000), "1.20M")
  })

  it("degrades to zero for non-finite input", () => {
    assert.equal(formatTokens(Number.NaN), "0")
    assert.equal(formatTokens(Number.POSITIVE_INFINITY), "0")
  })
})

describe("formatMoney", () => {
  it("renders usd and floors empty sessions at zero", () => {
    assert.equal(formatMoney(0.0123), "$0.01")
    assert.equal(formatMoney(1.5), "$1.50")
    assert.equal(formatMoney(0), "$0.00")
    assert.equal(formatMoney(-3), "$0.00")
  })
})
