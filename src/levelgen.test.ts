import { describe, expect, it } from 'bun:test'
import { T } from './tuning'
import { generateLevel, groundYAt, lipHeight, surfaceY, type GeneratedLevel } from './levelgen'
import type { PackBug } from './pack'
import { mulberry32 } from './rng'

/** Insects from 0.5 mm to ~80 mm, log-uniform, as squares-ish hulls. */
function syntheticBugs(n: number): PackBug[] {
  const rand = mulberry32(3)
  return Array.from({ length: n }, (_, i) => {
    const length = Math.exp(Math.log(0.5) + rand() * (Math.log(80) - Math.log(0.5)))
    const mmPerPx = length / 100
    return {
      id: `bug-${i}`, label: 'Lepidoptera', rank: 'order', order: i % 3 ? 'Lepidoptera' : 'Coleoptera',
      areaMm2: length * length * 0.4, mmPerPx, atlas: 0, x: 0, y: 0, w: 100, h: 60,
      hull: [-50, -30, 50, -30, 50, 30, -50, 30],
    }
  })
}

/** Height above (x, y) of the highest surface strictly below it: the floor or any path not skipped. */
function clearanceBelow(level: GeneratedLevel, x: number, y: number, skip: Set<number>): number {
  let best = groundYAt(level.ground, x)
  level.paths.forEach((p, i) => {
    if (skip.has(i)) return
    const py = surfaceY(p.points, x)
    if (py != null && py > y + 1e-6 && py < best) best = py
  })
  return best - y
}

describe('generateLevel', () => {
  const bugs = syntheticBugs(1500)
  const level = generateLevel(bugs, 1)

  it('places every insect exactly once, at finite positions', () => {
    expect(level.placements.length).toBe(bugs.length)
    expect(new Set(level.placements.map((p) => p.bug)).size).toBe(bugs.length)
    for (const p of level.placements) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.angle)).toBe(true)
    }
  })

  it('makes zones that double in radius, each area higher up and reached by a gated connector', () => {
    expect(level.zones.length).toBeGreaterThan(3)
    for (let i = 1; i < level.zones.length; i++) {
      const prev = level.zones[i - 1]!, zone = level.zones[i]!
      expect(zone.radius).toBeCloseTo(prev.radius * 2)
      expect(zone.baseY).toBeLessThan(prev.baseY - 5 * zone.radius) // higher (y down)
      expect(zone.needR).toBeGreaterThan(prev.radius * 1.5) // you have to grow to get there
      const lip = level.lips.find((l) => l.kind === 'connector' && l.zone === i)!
      expect(lip.needR).toBeCloseTo(zone.needR)
      // The connector ends where the area starts.
      const pts = level.paths[lip.path]!.points
      expect([pts[0]!, pts[pts.length - 2]!].some((x) => Math.abs(x - zone.arrive.x) < 1e-6)).toBe(true)
    }
  })

  it('does not lay zones out left to right', () => {
    const goesLeft = level.zones.slice(1).map((z, i) => z.arrive.x < level.zones[i]!.arrive.x)
    expect(goesLeft.some((l) => l) && goesLeft.some((l) => !l)).toBe(true)
  })

  it('keeps every path at least its lip height above whatever is under it (no way on without the size)', () => {
    level.paths.forEach((p, i) => {
      // A connector's top merges into its own area; that area isn't "under" it.
      const skip = new Set([i, ...(p.kind === 'connector' ? [level.zones[p.zone]!.path] : [])])
      for (let k = 0; k < p.points.length; k += 2) {
        expect(clearanceBelow(level, p.points[k]!, p.points[k + 1]!, skip)).toBeGreaterThanOrEqual(p.lip - 1e-6)
      }
    })
  })

  it('puts gaps in some higher areas and paths, with no ground across them and nothing sitting in them', () => {
    const gapped = level.paths.map((p, i) => ({ p, i })).filter(({ p }) => p.gaps?.length)
    expect(gapped.some(({ p }) => p.kind === 'area')).toBe(true)
    expect(gapped.some(({ p }) => p.kind === 'branch')).toBe(true)
    expect(level.paths.find((p) => p.kind === 'area' && p.zone === 0)).toBeUndefined() // the floor has none
    for (const { p, i } of gapped) {
      for (const [a, b] of p.gaps!) {
        expect(b - a).toBeGreaterThan(level.zones[p.zone]!.radius)
        const segs = level.ledges.filter((l) => l.path === i)
        expect(segs.some((l) => l.x0 < b - 1e-6 && l.x1 > a + 1e-6)).toBe(false)
        expect(segs.some((l) => l.gapRight && Math.abs(l.x1 - a) < 1e-6)).toBe(true)
        expect(segs.some((l) => l.gapLeft && Math.abs(l.x0 - b) < 1e-6)).toBe(true)
        expect(level.placements.some((pl) => pl.path === i && pl.x > a && pl.x < b)).toBe(false)
      }
    }
  })

  it('makes lips a hop with room to spare for a ball of the size they ask for', () => {
    for (const lip of level.lips.filter((l) => l.needR > 0)) {
      expect(lip.needR * T.paths.hopReach).toBeGreaterThan(1.05 * lipHeight(lip.needR))
    }
  })

  it('gives every area alternative paths, some needing a bigger ball, with insects up there', () => {
    for (const zone of level.zones) {
      const branches = level.paths.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'branch' && p.zone === zone.index)
      expect(branches.length).toBeGreaterThanOrEqual(1)
      for (const { i } of branches) expect(level.placements.some((pl) => pl.path === i)).toBe(true)
    }
    expect(level.paths.some((p) => p.kind === 'branch' && p.needR > 0)).toBe(true)
    expect(level.paths.some((p) => p.kind === 'branch' && p.needR === 0)).toBe(true)
  })

  it('puts the floor under everything', () => {
    const xs = level.ground.filter((_, i) => i % 2 === 0)
    const lo = Math.min(...xs), hi = Math.max(...xs)
    for (const p of level.paths) {
      expect(p.points[0]!).toBeGreaterThan(lo)
      expect(p.points[p.points.length - 2]!).toBeLessThan(hi)
    }
  })

  it('sits insects on top of the paths they belong to', () => {
    for (const pl of level.placements) {
      if (pl.path == null) continue
      const y = surfaceY(level.paths[pl.path]!.points, pl.x)
      expect(y).not.toBeNull()
      expect(pl.y).toBeLessThanOrEqual(y! + 1e-6)
      if (pl.mode === 'rest') expect(level.ledges[pl.seg!]!.path).toBe(pl.path)
    }
  })

  it('keeps obstacles on the way through low enough to hop over (only guards on side paths stand tall)', () => {
    for (const p of level.placements) {
      if (p.mode !== 'rest' || (p.path != null && level.paths[p.path]!.kind === 'branch')) continue
      const zone = level.zones[p.zone]!
      const info = level.info[p.bug]!
      if (info.length > 2 * zone.radius) expect(info.width).toBeLessThanOrEqual(0.9 * zone.radius + 1e-9)
    }
  })

  it('sends some bigger insects back to earlier areas, and stands some on open side paths as guards', () => {
    // Too big to pick up when you arrive (radius about R), and well past what the zone's own insects reach.
    const tooBig = level.placements.filter((p) => level.info[p.bug]!.length > 1.4 * level.zones[p.zone]!.radius)
    expect(tooBig.length).toBeGreaterThan(0.08 * level.placements.length)
    expect(new Set(tooBig.map((p) => p.mode)).size).toBe(3)
    const guards = level.placements.filter((p) => p.obstacle && p.path != null && level.paths[p.path]!.kind === 'branch')
    expect(guards.length).toBeGreaterThan(0)
    for (const g of guards) {
      expect(level.paths[g.path!]!.needR).toBe(0)
      expect(level.info[g.bug]!.length).toBeGreaterThan(T.visitors.blockLength[0] * level.zones[g.zone]!.radius - 1e-9)
    }
  })

  it('is deterministic for a seed', () => {
    const again = generateLevel(bugs, 1)
    expect(again.placements.slice(0, 50)).toEqual(level.placements.slice(0, 50))
    expect(again.ground).toEqual(level.ground)
    expect(again.paths).toEqual(level.paths)
  })
})
