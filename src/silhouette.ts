/**
 * Collision shapes for insects stuck to the ball, traced from the whole
 * silhouette — legs, antennae, everything — so a leggy wasp or crane fly
 * makes a spiky ball. (The pack's own hulls leave the legs off, which suits
 * an insect lying on the ground.)
 */

/**
 * Convex hull of the opaque pixels of one sprite in an RGBA buffer, in sprite
 * pixels around the sprite's centre (y down), simplified to `maxVerts`.
 */
export function alphaHull(rgba: Uint8ClampedArray, stride: number, x: number, y: number, w: number, h: number, threshold = 110, maxVerts = 12): number[] {
  const pts: Array<[number, number]> = []
  for (let row = 0; row < h; row++) {
    const base = ((y + row) * stride + x) * 4 + 3
    let lo = -1, hi = -1
    for (let col = 0; col < w; col++) if (rgba[base + col * 4]! >= threshold) { lo = col; break }
    if (lo < 0) continue
    for (let col = w - 1; col >= lo; col--) if (rgba[base + col * 4]! >= threshold) { hi = col; break }
    const cy = row + 0.5 - h / 2
    pts.push([lo - w / 2, cy - 0.5], [lo - w / 2, cy + 0.5], [hi + 1 - w / 2, cy - 0.5], [hi + 1 - w / 2, cy + 0.5])
  }
  if (pts.length < 3) return []
  return simplify(convexHull(pts), maxVerts).flat()
}

/** Monotone-chain convex hull, counter-clockwise. */
export function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Array<[number, number]> = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** Drops the vertex that cuts the least area until `maxVerts` are left (Visvalingam). */
function simplify(poly: Array<[number, number]>, maxVerts: number): Array<[number, number]> {
  const out = poly.slice()
  const area = (i: number) => {
    const a = out[(i + out.length - 1) % out.length]!, b = out[i]!, c = out[(i + 1) % out.length]!
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
  }
  while (out.length > maxVerts) {
    let worst = 0, least = Infinity
    for (let i = 0; i < out.length; i++) { const s = area(i); if (s < least) { least = s; worst = i } }
    out.splice(worst, 1)
  }
  return out
}

/** Farthest hull point from the centre. */
export function hullReach(hull: number[]): number {
  let r = 0
  for (let k = 0; k < hull.length; k += 2) r = Math.max(r, Math.hypot(hull[k]!, hull[k + 1]!))
  return r
}

/**
 * Whole-silhouette hulls for every insect in a pack, in sprite pixels (same
 * frame as `PackBug.hull`). Browser only: reads the atlas pixels.
 */
export function silhouetteHulls(atlases: ImageBitmap[], bugs: Array<{ atlas: number; x: number; y: number; w: number; h: number; hull: number[] }>): number[][] {
  const out: number[][] = bugs.map((b) => b.hull)
  atlases.forEach((bitmap, page) => {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    bugs.forEach((b, i) => {
      if (b.atlas !== page) return
      const hull = alphaHull(data, bitmap.width, b.x, b.y, b.w, b.h)
      if (hull.length >= 6) out[i] = hull
    })
  })
  return out
}
