import { describe, expect, it } from 'bun:test'
import { alphaHull, hullReach } from './silhouette'

/** A w×h RGBA buffer with opaque pixels where `on(col, row)`. */
function sprite(w: number, h: number, on: (c: number, r: number) => boolean): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (on(c, r)) buf[(r * w + c) * 4 + 3] = 255
  return buf
}

describe('alphaHull', () => {
  it('traces a solid block, centred', () => {
    const hull = alphaHull(sprite(20, 10, (c, r) => c >= 5 && c < 15 && r >= 2 && r < 8), 20, 0, 0, 20, 10)
    const xs = hull.filter((_, i) => i % 2 === 0), ys = hull.filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeCloseTo(-5); expect(Math.max(...xs)).toBeCloseTo(5)
    expect(Math.min(...ys)).toBeCloseTo(-3); expect(Math.max(...ys)).toBeCloseTo(3)
  })

  it('reaches out to thin legs that an opened mask would drop', () => {
    // A 10×6 body with a one-pixel leg running out to the right edge.
    const body = (c: number, r: number) => c >= 10 && c < 20 && r >= 12 && r < 18
    const leg = (c: number, r: number) => r === 14 && c >= 20 && c < 38
    const hull = alphaHull(sprite(40, 30, (c, r) => body(c, r) || leg(c, r)), 40, 0, 0, 40, 30)
    expect(Math.max(...hull.filter((_, i) => i % 2 === 0))).toBeCloseTo(18)
    expect(hullReach(hull)).toBeGreaterThan(17)
  })

  it('reads one sprite out of a bigger atlas and keeps at most 12 points', () => {
    const atlas = sprite(64, 64, (c, r) => Math.hypot(c - 40, r - 40) < 9) // a disc centred in the frame (31,31)-(49,49)
    const hull = alphaHull(atlas, 64, 31, 31, 18, 18)
    expect(hull.length / 2).toBeLessThanOrEqual(12)
    expect(hullReach(hull)).toBeGreaterThan(8)
    expect(hullReach(hull)).toBeLessThan(10.5)
  })
})
