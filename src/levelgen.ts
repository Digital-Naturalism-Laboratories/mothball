/**
 * Turns a pack's insects into a level. Pure and deterministic (seeded), so it
 * runs in tests and scripts as well as the game.
 *
 *  1. Zones from growth. Simulate rolling everything up smallest-first; each
 *     time the ball would double in radius, a new zone starts. Zone z holds
 *     the insects you grow on between its radius R and 2R.
 *  2. Areas. Zone 0 is the forest floor (solid ground). Every later zone is an
 *     area higher up: a long strip of one-way ground — solid from above, open
 *     from below, so nothing overhead can ever trap the ball. It starts where
 *     its connector arrives and runs off left or right at random, so the world
 *     is a heap of ever longer ledges going every which way, not a corridor.
 *  3. Paths. The way into zone z is its connector: a long one-way ramp that
 *     starts at a lip hanging over a flat spot in the area below and climbs
 *     `areaLift` × R to zone z's area. The lip is just too high to hop onto
 *     until the ball has the radius zone z needs. Every area also has a few
 *     alternative paths: they start from lips (a small hop, or one that needs
 *     a bigger ball), climb a little, wander along above the area and end in a
 *     drop. More insects live up there.
 *     Every path stays at least its lip's height above whatever is under it,
 *     so nothing can be reached from below without the size its lip asks for.
 *  4. Insects. Most fly (weighted by order); the rest perch on plants or sit
 *     spread out on the surfaces, the smallest nearest where you arrive. A few
 *     long, flat insects from later zones lie in the way as obstacles you can
 *     hop over.
 *
 * Units are millimetres, y points down (as on screen).
 */
import { T } from './tuning'
import { hullMm, longAxis, type PackBug } from './pack'
import { mulberry32, range } from './rng'

export type BugInfo = {
  /** Hull in mm around the centre. */
  hull: number[]
  /** Longest dimension, mm. */
  length: number
  /** Angle of the long axis in the sprite. */
  axis: number
  /** Extent across the long axis, mm: how tall it stands lying along a surface. */
  width: number
  area: number
}

export type Zone = {
  index: number
  /** Expected core radius on arriving. */
  radius: number
  /** Core radius needed to hop onto the lip of the path that leads here (0 for the floor). */
  needR: number
  /** This zone's area in `paths` (-1: the forest floor). */
  path: number
  x0: number
  x1: number
  /** Height of the area's flat parts. */
  baseY: number
  /** Where you arrive (the spawn, or the top of the connector). */
  arrive: { x: number; y: number }
}

export type PathKind = 'area' | 'connector' | 'branch'

/** One-way ground: solid from above, open from below. */
export type Path = {
  zone: number
  kind: PathKind
  /** Top surface, flat [x, y, …], left to right. */
  points: number[]
  /** Core radius needed to hop onto its lip (0: a small hop anyone can make). */
  needR: number
  /** Height of its lip above the surface under it; the whole path is at least this high. */
  lip: number
  /** x-ranges with no ground: hop them, roll across if you're big enough, or fall. */
  gaps?: Array<[number, number]>
}

/** One segment of a path (x0 < x1). `gapLeft` / `gapRight`: that end is the edge of a gap. */
export type Ledge = { path: number; zone: number; x0: number; y0: number; x1: number; y1: number; gapLeft?: boolean; gapRight?: boolean }

/** Where a path can be hopped onto from below. */
export type Lip = { path: number; zone: number; x: number; y: number; needR: number; kind: 'connector' | 'branch' }

export type Placement = {
  bug: number
  zone: number
  /** rest: on a surface (solid) · perch: on a plant or a path · fly: in the air */
  mode: 'rest' | 'perch' | 'fly'
  x: number
  y: number
  angle: number
  /** rest: surface direction, for crawling along it. */
  tx?: number
  ty?: number
  /** Too big to pick up in this zone; placed in the way on purpose. */
  obstacle?: boolean
  /** On this one-way path (index into `paths`) rather than the floor or a plant. */
  path?: number
  /** rest on a path: the segment under it (index into `ledges`). */
  seg?: number
}

export type Plant = { zone: number; x: number; y: number; height: number; lean: number; bend: number; width: number; big: boolean }

export type GeneratedLevel = {
  /** Forest floor polyline (solid), flat [x, y, …], left wall to right wall. */
  ground: number[]
  zones: Zone[]
  paths: Path[]
  ledges: Ledge[]
  lips: Lip[]
  placements: Placement[]
  plants: Plant[]
  spawn: { x: number; y: number }
  info: BugInfo[]
  /** Lowest point of the floor, for filling the terrain. */
  bottomY: number
}

type Poly = number[] // flat polyline in travel order

type Area = {
  zone: number
  R: number
  /** Index in `paths`, or -1 for the floor. */
  path: number
  /** Surface left to right (with any end curl). */
  surface: number[]
  /** Surface in travel order from the arrival, without curls (for laying insects). */
  walk: Poly[]
  spots: number[]
  used: Set<number>
  kickers: Array<[number, number]>
  /** x-ranges taken by paths that hang low over the area. */
  taken: Array<[number, number]>
  gaps: Array<[number, number]>
  x0: number
  x1: number
  baseY: number
}

export function bugInfo(bugs: PackBug[]): BugInfo[] {
  return bugs.map((b) => {
    const hull = hullMm(b)
    const { length, angle } = longAxis(hull)
    const px = -Math.sin(angle), py = Math.cos(angle)
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k < hull.length; k += 2) {
      const d = hull[k]! * px + hull[k + 1]! * py
      lo = Math.min(lo, d); hi = Math.max(hi, d)
    }
    return { hull, length: Math.max(length, 0.05), axis: angle, width: Math.max(hi - lo, 0.02), area: Math.max(b.areaMm2, 0.01) }
  })
}

/** Height of a lip that a ball of `needR` hops onto with a little room to spare. */
export function lipHeight(needR: number): number {
  return T.paths.hopReach * T.paths.lipEase * needR
}

export function generateLevel(bugs: PackBug[], seed = 1): GeneratedLevel {
  const rand = mulberry32(seed)
  const info = bugInfo(bugs)
  const P = T.paths

  // ── 1. zones from a greedy smallest-first roll-up ──
  const bySize = info.map((_, i) => i).sort((a, b) => info[a]!.length - info[b]!.length)
  const zoneBugs: number[][] = [[]]
  const zoneRadius: number[] = [T.startRadius]
  let r: number = T.startRadius
  let next: number = r * T.zoneGrowth
  for (const i of bySize) {
    zoneBugs[zoneBugs.length - 1]!.push(i)
    r = Math.sqrt(r * r + (T.growth * info[i]!.area) / Math.PI)
    while (r >= next) {
      zoneBugs.push([])
      zoneRadius.push(next)
      next *= T.zoneGrowth
    }
  }
  while (zoneBugs.length > 1 && zoneBugs[zoneBugs.length - 1]!.length === 0) { zoneBugs.pop(); zoneRadius.pop() }
  // A thin last zone isn't worth an area: fold it into the previous one.
  if (zoneBugs.length > 1 && zoneBugs[zoneBugs.length - 1]!.length < 0.3 * zoneBugs[zoneBugs.length - 2]!.length) {
    zoneBugs[zoneBugs.length - 2]!.push(...zoneBugs.pop()!)
    zoneRadius.pop()
  }
  const nz = zoneBugs.length

  // Who flies, who perches, who sits.
  const role = new Array<'rest' | 'perch' | 'fly'>(info.length)
  for (let i = 0; i < bugs.length; i++) {
    const chance = T.flyerChance[bugs[i]!.order ?? ''] ?? T.flyerChance.default!
    role[i] = rand() < chance ? 'fly' : rand() < T.perchShare ? 'perch' : 'rest'
  }
  const ofRole = (z: number, want: string) => zoneBugs[z]!.filter((i) => role[i] === want)
  const sitters = zoneBugs.map((_, z) => ofRole(z, 'rest'))

  // Obstacles: a few sitters from later zones, too long to pick up for most of
  // this one. Only low, flat ones, so a hop gets you over.
  const obstacles: number[][] = zoneBugs.map(() => [])
  for (let z = 0; z + 1 < nz; z++) {
    const R = zoneRadius[z]!
    const fits = (i: number) => info[i]!.width <= 0.9 * R && info[i]!.length >= 1.4 * R
    for (const ahead of [z + 1, z + 2]) {
      const pool = sitters[ahead]
      if (!pool) continue
      let take = Math.floor((pool.length * T.obstacleShare) / 2)
      for (let k = pool.length - 1; k >= 0 && take > 0; k--) {
        if (rand() < 0.5 && fits(pool[k]!)) { obstacles[z]!.push(pool.splice(k, 1)[0]!); take-- }
      }
    }
  }

  const paths: Path[] = []
  const lips: Lip[] = []
  const zones: Zone[] = []
  const areas: Area[] = []
  /** Alternative path → its surface in travel order after the lip pad, in pieces between gaps (for laying insects). */
  const branchWalk = new Map<number, Poly[]>()

  // ── 2 + 3. areas and connectors ──
  const minSpots = 2 + P.branches[1]
  const profileFor = (z: number) => {
    const R = zoneRadius[z]!
    const need = sitters[z]!.reduce((s, i) => s + info[i]!.length * T.sitterSpacing, 0)
    return makeProfile(R, Math.max(T.minZoneRadii * R, need / (1 + 0.5 * P.density)), rand, minSpots, z > 0)
  }

  // Zone 0: the forest floor. You start at the spot nearest its middle; it spreads both ways.
  const prof0 = profileFor(0)
  const R0 = zoneRadius[0]!
  const spawnX = prof0.spots.reduce((best, s) => (Math.abs(s - prof0.length / 2) < Math.abs(best - prof0.length / 2) ? s : best))
  areas.push({
    zone: 0, R: R0, path: -1, surface: prof0.pts, walk: [cutPoly(prof0.pts, spawnX, -1), cutPoly(prof0.pts, spawnX, 1)],
    spots: prof0.spots.slice(), used: new Set([spawnX]), kickers: prof0.kickers.map((k) => [k.x0, k.x1]), taken: [], gaps: [],
    x0: 0, x1: prof0.length, baseY: 0,
  })
  zones.push({ index: 0, radius: R0, needR: 0, path: -1, x0: 0, x1: prof0.length, baseY: 0, arrive: { x: spawnX, y: 0 } })

  for (let z = 1; z < nz; z++) {
    const below = areas[z - 1]!
    const R = zoneRadius[z]!
    const needR = T.gateFraction * R
    const h = lipHeight(needR)
    const dir = rand() < 0.5 ? 1 : -1
    // The lip hangs over a free flat spot of the area below…
    const free = below.spots.filter((s) => !below.used.has(s))
    const spot = free.length ? free[Math.floor(rand() * free.length)]! : below.spots[0]!
    below.used.add(spot)
    const lipX = spot - dir * 0.5 * R
    const padY = (surfaceY(below.surface, spot) ?? below.baseY) - h
    // …then a long ramp (gentle at both ends) climbs to the new area.
    const rise = P.areaLift * R - h
    const run = rise / P.slope
    const conn: Poly = [lipX - dir * 2 * R, padY, lipX + dir * 3 * R, padY]
    const steps = Math.ceil(run / (0.5 * R))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      conn.push(lipX + dir * (3 * R + run * t), padY - rise * ease(t))
    }
    keepAbove(conn, below.surface, h)
    const arriveX = conn[conn.length - 2]!, arriveY = conn[conn.length - 1]!
    // Near its lip the ramp hangs low over the area below, within a hop of the alternative
    // paths' tops: keep them away from there.
    below.taken.push(lowRange(conn, below.surface, 6.5 * below.R))

    // The area runs on from the top of the ramp, the same way, and curls up at its far end.
    const prof = profileFor(z)
    const travel: Poly = []
    for (let k = 0; k < prof.pts.length; k += 2) travel.push(arriveX + dir * prof.pts[k]!, arriveY + prof.pts[k + 1]!)
    const endX = travel[travel.length - 2]!, endY = travel[travel.length - 1]!
    const [cr, cu] = P.endCurl
    const surface = toLeftRight([...travel, endX + dir * cr * R * 0.55, endY - cu * R * 0.3, endX + dir * cr * R, endY - cu * R])
    const gaps = prof.gaps.map(([a, b]) => (dir > 0 ? [arriveX + a, arriveX + b] : [arriveX - b, arriveX - a]) as [number, number]).sort((a, b) => a[0] - b[0])
    const connIndex = paths.push({ zone: z, kind: 'connector', points: toLeftRight(conn), needR, lip: h }) - 1
    const areaIndex = paths.push({ zone: z, kind: 'area', points: surface, needR, lip: h, ...(gaps.length ? { gaps } : {}) }) - 1
    lips.push({ path: connIndex, zone: z, x: lipX, y: padY, needR, kind: 'connector' })
    const x0 = surface[0]!, x1 = surface[surface.length - 2]!
    areas.push({
      zone: z, R, path: areaIndex, surface, walk: splitAtGaps(travel, gaps), spots: prof.spots.map((s) => arriveX + dir * s), used: new Set(),
      kickers: prof.kickers.map((k) => (dir > 0 ? [arriveX + k.x0, arriveX + k.x1] : [arriveX - k.x1, arriveX - k.x0])),
      taken: [], gaps, x0, x1, baseY: arriveY,
    })
    zones.push({ index: z, radius: R, needR, path: areaIndex, x0, x1, baseY: arriveY, arrive: { x: arriveX, y: arriveY } })
  }

  // Alternative paths over every area.
  const branchesOf: number[][] = areas.map(() => [])
  for (const area of areas) {
    const count = Math.round(range(rand, P.branches[0], P.branches[1]))
    for (let k = 0; k < count; k++) {
      const b = makeBranch(area, rand)
      if (!b) continue
      const index = paths.push({ zone: area.zone, kind: 'branch', points: toLeftRight(b.poly), needR: b.needR, lip: b.lip, ...(b.gaps.length ? { gaps: b.gaps } : {}) }) - 1
      branchesOf[area.zone]!.push(index)
      branchWalk.set(index, splitAtGaps(b.poly.slice(2), b.gaps))
      lips.push({ path: index, zone: area.zone, x: b.lipX, y: b.poly[1]!, needR: b.needR, kind: 'branch' })
    }
  }

  // ── the forest floor: zone 0 in the middle, gentle ground out to under everything, then walls ──
  let minX = 0, maxX = prof0.length, topY = 0
  for (const p of paths) {
    for (let k = 0; k < p.points.length; k += 2) {
      minX = Math.min(minX, p.points[k]!); maxX = Math.max(maxX, p.points[k]!); topY = Math.min(topY, p.points[k + 1]!)
    }
  }
  const lastR = zoneRadius[nz - 1]!
  const rightExt = floorExtension(maxX + 15 * lastR - prof0.length, R0, lastR, rand)
  const leftExt = floorExtension(15 * lastR - minX, R0, lastR, rand)
  const ground: number[] = []
  for (let k = leftExt.length - 2; k >= 2; k -= 2) ground.push(-leftExt[k]!, leftExt[k + 1]!)
  ground.push(...prof0.pts)
  for (let k = 2; k < rightExt.length; k += 2) ground.push(prof0.length + rightExt[k]!, rightExt[k + 1]!)
  let bottomY = 0
  for (let k = 1; k < ground.length; k += 2) bottomY = Math.max(bottomY, ground[k]!)
  topY -= 60 * lastR
  ground.unshift(ground[0]!, topY)
  ground.push(ground[ground.length - 2]!, topY)

  // ── 4. insects ──
  const placements: Placement[] = []
  const plants: Plant[] = []
  for (const area of areas) {
    const z = area.zone, R = area.R
    const branchIds = branchesOf[z]!
    const mainLen = area.walk.reduce((s, p) => s + polyLength(p), 0)
    const branchLens = branchIds.map((b) => branchWalk.get(b)!.reduce((s, p) => s + polyLength(p), 0))
    const weight = mainLen + P.density * branchLens.reduce((a, b) => a + b, 0)
    const share = (k: number) => (P.density * branchLens[k]!) / weight

    // Ground insects: a bigger share per length up on the alternative paths (bigger ones on the
    // gated ones), the rest along the area, smallest nearest where you arrive.
    const ground = sitters[z]!.sort((a, b) => info[a]!.length - info[b]!.length)
    const total = ground.length
    const onBranch: number[][] = branchIds.map((b, k) => {
      const take: number[] = []
      const gated = paths[b]!.needR > 0
      for (let j = Math.round(total * share(k)); j > 0 && ground.length; j--) {
        const at = gated ? Math.floor(range(rand, 0.5, 1) * ground.length) : Math.floor(rand() * ground.length)
        take.push(ground.splice(Math.min(at, ground.length - 1), 1)[0]!)
      }
      return take.sort((a, c) => info[a]!.length - info[c]!.length)
    })
    jitterOrder(ground, rand, 8)
    for (const i of obstacles[z]!) ground.splice(Math.floor(range(rand, 0.15, 1) * ground.length), 0, i)
    const obstacleSet = new Set(obstacles[z]!)
    const onArea = area.path >= 0 ? area.path : undefined
    if (area.walk.length === 2) {
      // The floor spreads both ways from the spawn: alternate.
      placeAlong([area.walk[0]!], ground.filter((_, j) => j % 2 === 0), info, z, rand, placements, obstacleSet, onArea)
      placeAlong([area.walk[1]!], ground.filter((_, j) => j % 2 === 1), info, z, rand, placements, obstacleSet, onArea)
    } else {
      placeAlong(area.walk, ground, info, z, rand, placements, obstacleSet, onArea)
    }
    branchIds.forEach((b, k) => placeAlong(branchWalk.get(b)!, onBranch[k]!, info, z, rand, placements, new Set(), b))

    // Perched insects: some sitting up on the alternative paths, the rest on plants (now and then a big one).
    const perched = ofRole(z, 'perch')
    const perchTotal = perched.length
    shuffleInPlace(perched, rand)
    branchIds.forEach((b, k) => {
      const segs = concatPaths(branchWalk.get(b)!)
      const len = segsLength(segs)
      const n = Math.min(perched.length, Math.round(perchTotal * share(k)))
      for (let j = 0; j < n && segs.length; j++) {
        const i = perched.pop()!
        const at = pointAt(segs, ((j + range(rand, 0.2, 0.8)) / n) * len)
        const lift = 0.45 * info[i]!.width
        placements.push({
          bug: i, zone: z, mode: 'perch', path: b, x: at.x + at.nx * lift, y: at.y + at.ny * lift,
          angle: Math.atan2(at.ty, at.tx) - info[i]!.axis + (rand() < 0.5 ? Math.PI : 0) + range(rand, -0.1, 0.1),
        })
      }
    })
    let p = 0
    while (p < perched.length) {
      let px = range(rand, area.x0 + 4 * R, area.x1 - 6 * R)
      for (let tries = 0; tries < 8 && inGap(area.gaps, px, 1.5 * R); tries++) px = range(rand, area.x0 + 4 * R, area.x1 - 6 * R)
      const big = rand() < T.bigPlantShare
      const height = (big ? range(rand, 6, 9) : range(rand, 2.2, 5.5)) * R
      const plant: Plant = {
        zone: z, x: px, y: surfaceY(area.surface, px) ?? area.baseY, height, lean: range(rand, -0.25, 0.25) * (big ? 0.5 : 1),
        bend: range(rand, -0.5, 0.5) * R * (big ? 2 : 1), width: (big ? 0.16 : 0.09) * R, big,
      }
      plants.push(plant)
      const count = Math.min(perched.length - p, big ? 3 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 3))
      for (let k = 0; k < count; k++, p++) {
        const i = perched[p]!
        const f = k === 0 ? 1 : range(rand, 0.4, 0.85)
        const at = plantPoint(plant, f)
        const side = k === 0 ? 0 : (k % 2 ? 1 : -1) * 0.35 * info[i]!.width
        placements.push({
          bug: i, zone: z, mode: 'perch', x: at.x + side, y: at.y - (k === 0 ? 0.3 * info[i]!.length : 0),
          angle: at.angle - info[i]!.axis + (rand() < 0.5 ? Math.PI : 0) + range(rand, -0.3, 0.3),
        })
      }
    }

    // Flyers hover over the area; some around the alternative paths.
    for (const i of ofRole(z, 'fly')) {
      const b = branchIds.length && rand() < 0.35 ? branchIds[Math.floor(rand() * branchIds.length)]! : -1
      let fx: number, fy: number
      if (b >= 0) {
        const pts = paths[b]!.points
        fx = range(rand, pts[0]!, pts[pts.length - 2]!)
        fy = (surfaceY(pts, fx) ?? area.baseY) - range(rand, 0.6, 5) * R
      } else {
        fx = range(rand, area.x0 + 4 * R, area.x1 - 4 * R)
        fy = (surfaceY(area.surface, fx) ?? area.baseY) - range(rand, 1.5, 8) * R
      }
      placements.push({ bug: i, zone: z, mode: 'fly', x: fx, y: fy, angle: rand() * Math.PI * 2 })
    }
  }

  // ── one-way segments, and which one each insect on a path sits on ──
  const ledges: Ledge[] = []
  const segsOf: number[][] = paths.map(() => [])
  paths.forEach((p, pi) => {
    const gaps = p.gaps ?? []
    for (let k = 0; k + 3 < p.points.length; k += 2) {
      const x0 = p.points[k]!, y0 = p.points[k + 1]!, x1 = p.points[k + 2]!, y1 = p.points[k + 3]!
      if (x1 - x0 < 1e-6 || inGap(gaps, (x0 + x1) / 2)) continue
      const gapLeft = gaps.some(([, b]) => Math.abs(x0 - b) < 1e-6), gapRight = gaps.some(([a]) => Math.abs(x1 - a) < 1e-6)
      segsOf[pi]!.push(ledges.push({ path: pi, zone: p.zone, x0, y0, x1, y1, ...(gapLeft ? { gapLeft } : {}), ...(gapRight ? { gapRight } : {}) }) - 1)
    }
  })
  for (const pl of placements) {
    if (pl.mode !== 'rest' || pl.path == null) continue
    const segs = segsOf[pl.path]!
    let best = segs[0]!
    for (const s of segs) if (ledges[s]!.x0 <= pl.x) best = s
    pl.seg = best
  }

  return {
    ground, zones, paths, ledges, lips, placements, plants, info,
    spawn: { x: spawnX, y: -2 * R0 },
    bottomY: bottomY + 40 * lastR,
  }

  /** An alternative path over a free spot of `area`, or null if there's no room. */
  function makeBranch(area: Area, rand: () => number): { poly: Poly; lipX: number; needR: number; lip: number; gaps: Array<[number, number]> } | null {
    const R = area.R
    const free = area.spots.filter((s) => !area.used.has(s) && !area.taken.some(([a, b]) => s > a - 3 * R && s < b + 3 * R))
    shuffleInPlace(free, rand)
    const gated = rand() < P.gatedShare
    const needR = gated ? range(rand, P.gatedRadius[0], P.gatedRadius[1]) * R : 0
    const lip = gated ? lipHeight(needR) : P.openLip * R
    const climb = range(rand, P.cruiseLift[0], P.cruiseLift[1]) * R
    const rampRun = climb / P.branchSlope
    const cruise0 = range(rand, P.cruise[0], P.cruise[1]) * R
    const dirs = rand() < 0.5 ? [1, -1] : [-1, 1]
    for (const spot of free) for (const dir of dirs) {
      for (const cruise of [cruise0, 0.6 * cruise0, 14 * R]) {
        const lipX = spot - dir * 0.5 * R
        const start = lipX - dir * 2 * R, x2 = lipX + dir * 2.5 * R, x3 = x2 + dir * rampRun, end = x3 + dir * cruise
        const lo = Math.min(start, end), hi = Math.max(start, end)
        if (lo < area.x0 + 5 * R || hi > area.x1 - 5 * R) continue
        if (area.taken.some(([a, b]) => hi > a && lo < b)) continue
        if (gated && area.kickers.some(([a, b]) => hi > a - 4 * R && lo < b + 4 * R)) continue // no launching onto it
        const padY = (surfaceY(area.surface, spot) ?? area.baseY) - lip
        const poly: Poly = [start, padY, x2, padY]
        const steps = Math.ceil(rampRun / (0.5 * R))
        for (let k = 1; k <= steps; k++) {
          const t = k / steps
          poly.push(x2 + dir * rampRun * t, padY - climb * ease(t))
        }
        const cy = padY - climb, wave = range(rand, 8, 13) * R, phase = rand() * Math.PI * 2
        // Now and then a gap partway along.
        const G = P.gaps
        const gapAt = cruise >= 16 * R && rand() < G.branchChance ? range(rand, 0.35, 0.6) * cruise : -1
        const gapW = range(rand, G.branchWidth[0], G.branchWidth[1]) * R
        const along: number[] = []
        for (let s = R; s <= cruise + 1e-6; s += R) if (gapAt < 0 || s < gapAt - 0.2 * R || s > gapAt + gapW + 0.2 * R) along.push(s)
        if (gapAt >= 0) along.push(gapAt, gapAt + gapW)
        along.sort((a, b) => a - b)
        for (const s of along) {
          const env = Math.sin((Math.PI * s) / cruise)
          const droop = Math.max(0, s - (cruise - 3 * R)) * 0.25
          poly.push(x3 + dir * s, cy + 0.4 * R * env * Math.sin((2 * Math.PI * s) / wave + phase) + droop)
        }
        keepAbove(poly, area.surface, lip)
        area.used.add(spot)
        area.taken.push([lo, hi])
        const gaps: Array<[number, number]> = gapAt < 0 ? [] : [[x3 + dir * gapAt, x3 + dir * (gapAt + gapW)].sort((a, b) => a - b) as [number, number]]
        return { poly, lipX, needR, lip, gaps }
      }
    }
    return null
  }
}

/** 0 → 1 with zero slope at both ends; the steepest part is twice the average. */
function ease(t: number): number {
  return t - Math.sin(2 * Math.PI * t) / (2 * Math.PI)
}

/**
 * A strip of terrain from x = 0 (y = 0 is its flat baseline): an entry flat,
 * then rolling hills, half-pipe bowls, launch ramps, flat spots (where paths
 * start) and, if `withGaps`, gaps, until it's at least `minLength` long with
 * `minSpots` spots. A launch ramp never sits right next to a spot, so it can't
 * launch you onto a lip you're too small for (a ramp before a gap is fine: jump it).
 */
function makeProfile(R: number, minLength: number, rand: () => number, minSpots: number, withGaps = false): {
  pts: number[]; spots: number[]; kickers: Array<{ x0: number; x1: number }>; gaps: Array<[number, number]>; length: number
} {
  const pts = [0, 0]
  const spots: number[] = []
  const gaps: Array<[number, number]> = []
  const kickers: Array<{ x0: number; x1: number }> = []
  let x = 0
  const line = (nx: number, ny: number) => { pts.push(nx, ny); x = nx }
  line(6 * R, 0)
  let last = ''
  while (x < minLength || spots.length < minSpots) {
    // Spots get likelier while there aren't enough of them for the length left.
    const left = Math.max(minLength - x, 0)
    const pSpot = clamp(((minSpots - spots.length) * 18 * R) / Math.max(left, 18 * R), 0.15, 0.85)
    const roll = rand()
    let feature = roll < pSpot ? 'spot' : roll < pSpot + (1 - pSpot) * 0.3 ? 'kicker' : roll < pSpot + (1 - pSpot) * 0.55 ? 'bowl' : 'hills'
    if (feature === 'kicker' && (last === 'kicker' || last === 'spot')) feature = 'hills'
    if (feature === 'spot' && (last === 'spot' || last === 'kicker')) feature = 'bowl'
    // Gaps now and then (every higher area gets at least one).
    const gapChance = gaps.length === 0 && x > 0.5 * minLength ? 0.6 : T.paths.gaps.chance
    if (withGaps && x > 20 * R && last !== 'gap' && feature !== 'spot' && rand() < gapChance) feature = 'gap'
    last = feature
    const sx = x
    if (feature === 'gap') {
      const w = range(rand, T.paths.gaps.width[0], T.paths.gaps.width[1]) * R
      line(sx + 2 * R, 0)
      gaps.push([x, x + w])
      line(x + w, 0)
      line(x + 2 * R, 0)
    } else if (feature === 'spot') {
      spots.push(sx + (T.paths.spotLength * R) / 2)
      line(sx + T.paths.spotLength * R, 0)
    } else if (feature === 'hills') {
      const len = range(rand, 16, 26) * R
      const a1 = 0.7 * R, l1 = range(rand, 10, 16) * R, p1 = rand() * Math.PI * 2
      const a2 = 0.25 * R, l2 = range(rand, 4, 6) * R, p2 = rand() * Math.PI * 2
      for (let s = R; s <= len + 1e-6; s += R) {
        const env = Math.sin((Math.PI * s) / len)
        line(sx + s, env * (a1 * Math.sin((2 * Math.PI * s) / l1 + p1) + a2 * Math.sin((2 * Math.PI * s) / l2 + p2)))
      }
      pts[pts.length - 1] = 0
    } else if (feature === 'bowl') {
      const len = range(rand, 10, 14) * R, depth = range(rand, 1.8, 2.6) * R
      for (let s = R / 2; s <= len + 1e-6; s += R / 2) line(sx + s, depth * 0.5 * (1 - Math.cos((2 * Math.PI * s) / len)))
      pts[pts.length - 1] = 0
    } else {
      // Launch ramp: a run-up that steepens to a lip, then a slope back down.
      const run = range(rand, 5, 7) * R, h = range(rand, 1.2, 1.6) * R, drop = 1.4 * h
      for (let s = R / 2; s <= run + 1e-6; s += R / 2) line(sx + s, -h * Math.pow(s / run, 2.5))
      line(sx + run + drop, 0)
      kickers.push({ x0: sx, x1: x })
    }
  }
  line(x + 6 * R, 0)
  return { pts, spots, kickers, gaps, length: x }
}

/** Gentle ground from x = 0 outwards for `length`, its bumps growing from scale `s0` up to `s1`. */
function floorExtension(length: number, s0: number, s1: number, rand: () => number): number[] {
  const out = [0, 0]
  let x = 0, s = s0
  while (x < length) {
    const len = 30 * s, wave = range(rand, 10, 16) * s, phase = rand() * Math.PI * 2
    for (let d = s; d <= len + 1e-6; d += s) {
      out.push(x + d, 0.3 * s * Math.sin((Math.PI * d) / len) * Math.sin((2 * Math.PI * d) / wave + phase))
    }
    out[out.length - 1] = 0
    x += len
    s = Math.min(s1, s * 2)
  }
  return out
}

/** Is x inside one of the gaps (widened by `margin` each side)? */
function inGap(gaps: Array<[number, number]>, x: number, margin = 0): boolean {
  return gaps.some(([a, b]) => x > a - margin && x < b + margin)
}

/** A polyline (travel order) cut into the pieces between gaps. */
function splitAtGaps(poly: Poly, gaps: Array<[number, number]>): Poly[] {
  if (!gaps.length) return [poly]
  const out: Poly[] = []
  let piece: Poly = [poly[0]!, poly[1]!]
  for (let k = 2; k < poly.length; k += 2) {
    if (inGap(gaps, (poly[k - 2]! + poly[k]!) / 2)) {
      if (piece.length >= 4) out.push(piece)
      piece = []
    }
    piece.push(poly[k]!, poly[k + 1]!)
  }
  if (piece.length >= 4) out.push(piece)
  return out
}

/** Lifts a path wherever it would come lower than `lip` over `surface` (a left-to-right polyline). */
function keepAbove(poly: Poly, surface: number[], lip: number): void {
  for (let k = 0; k < poly.length; k += 2) {
    // Look a little either side too, so a segment can't dip onto a bump between its ends.
    let top = Infinity
    for (const dx of [-0.6, 0, 0.6]) {
      const y = surfaceY(surface, poly[k]! + dx * lip)
      if (y != null) top = Math.min(top, y)
    }
    if (top < Infinity) poly[k + 1] = Math.min(poly[k + 1]!, top - lip)
  }
}

/** x-range where a path hangs within `height` of the surface under it. */
function lowRange(poly: Poly, surface: number[], height: number): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (let k = 0; k < poly.length; k += 2) {
    const y = surfaceY(surface, poly[k]!)
    if (y != null && y - poly[k + 1]! < height) { lo = Math.min(lo, poly[k]!); hi = Math.max(hi, poly[k]!) }
  }
  return lo <= hi ? [lo, hi] : [0, 0]
}

/** The part of a left-to-right polyline from x = `at` going `dir`, in travel order. */
function cutPoly(pts: number[], at: number, dir: 1 | -1): Poly {
  const out: Poly = [at, surfaceY(pts, at) ?? 0]
  if (dir > 0) { for (let k = 0; k < pts.length; k += 2) if (pts[k]! > at) out.push(pts[k]!, pts[k + 1]!) }
  else { for (let k = pts.length - 2; k >= 0; k -= 2) if (pts[k]! < at) out.push(pts[k]!, pts[k + 1]!) }
  return out
}

function toLeftRight(poly: Poly): number[] {
  if (poly.length < 4 || poly[0]! <= poly[poly.length - 2]!) return poly.slice()
  const out: number[] = []
  for (let k = poly.length - 2; k >= 0; k -= 2) out.push(poly[k]!, poly[k + 1]!)
  return out
}

/** Height of a left-to-right polyline at x, or null outside it. */
export function surfaceY(pts: number[], x: number): number | null {
  if (pts.length < 4 || x < pts[0]! || x > pts[pts.length - 2]!) return null
  let lo = 0, hi = pts.length / 2 - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (pts[2 * mid]! <= x) lo = mid
    else hi = mid
  }
  const ax = pts[2 * lo]!, bx = pts[2 * hi]!
  const u = bx > ax ? (x - ax) / (bx - ax) : 0
  return pts[2 * lo + 1]! + (pts[2 * hi + 1]! - pts[2 * lo + 1]!) * u
}

function polyLength(p: Poly): number {
  let s = 0
  for (let k = 0; k + 3 < p.length; k += 2) s += Math.hypot(p[k + 2]! - p[k]!, p[k + 3]! - p[k + 1]!)
  return s
}

/** A point `u` of the way from a to b, with the normal pointing up (y down). */
function pathPoint(ax: number, ay: number, bx: number, by: number, u: number): PathPoint {
  const len = Math.hypot(bx - ax, by - ay) || 1
  const tx = (bx - ax) / len, ty = (by - ay) / len
  let nx = ty, ny = -tx
  if (ny > 0) { nx = -nx; ny = -ny }
  return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, tx, ty, nx, ny }
}

/** A point `f` (0 base … 1 tip) up a plant stalk, and the stalk's direction there. */
export function plantPoint(p: Plant, f: number): { x: number; y: number; angle: number } {
  // Quadratic curve: base → control (bent sideways) → tip.
  const tipX = p.x + Math.sin(p.lean) * p.height, tipY = p.y - Math.cos(p.lean) * p.height
  const cx = (p.x + tipX) / 2 + p.bend, cy = (p.y + tipY) / 2
  const u = 1 - f
  const x = u * u * p.x + 2 * u * f * cx + f * f * tipX
  const y = u * u * p.y + 2 * u * f * cy + f * f * tipY
  const dx = 2 * u * (cx - p.x) + 2 * f * (tipX - cx), dy = 2 * u * (cy - p.y) + 2 * f * (tipY - cy)
  return { x, y, angle: Math.atan2(dy, dx) }
}

/** Lays insects along consecutive polylines (in travel order), spread evenly over their length. */
function placeAlong(polys: Poly[], ids: number[], info: BugInfo[], zone: number, rand: () => number, out: Placement[], obstacles: Set<number>, path?: number): void {
  if (!ids.length || !polys.length) return
  const segs = concatPaths(polys)
  if (!segs.length) return
  const total = segsLength(segs)
  const sumLen = ids.reduce((s, i) => s + info[i]!.length, 0)
  const stretch = Math.max(0.6, total / Math.max(sumLen, 1e-6))
  let s = range(rand, 0, 0.5) * (total / ids.length)
  for (const i of ids) {
    const b = info[i]!
    const probe = pointAt(segs, s)
    const angle = Math.atan2(probe.ty, probe.tx) - b.axis + (rand() < 0.5 ? Math.PI : 0) + range(rand, -0.15, 0.15)
    const { along, depth } = poseExtents(b.hull, angle, probe)
    // Keep clear of the far end: on a drooping end the lift off the surface would push it past.
    const at = pointAt(segs, clamp(s + along / 2, 0, Math.max(0, total - along / 2 - b.width)))
    out.push({
      bug: i, zone, mode: 'rest', x: at.x + at.nx * depth * 0.85, y: at.y + at.ny * depth * 0.85, angle, tx: at.tx, ty: at.ty,
      ...(obstacles.has(i) ? { obstacle: true } : {}),
      ...(path != null ? { path } : {}),
    })
    s += b.length * stretch * range(rand, 0.6, 1.4)
    if (s > total) s %= Math.max(total, 1e-6)
  }
}

/** Extent of a rotated hull along the surface tangent, and how far it reaches into the surface. */
function poseExtents(hull: number[], angle: number, p: { tx: number; ty: number; nx: number; ny: number }): { along: number; depth: number } {
  const c = Math.cos(angle), s = Math.sin(angle)
  let lo = Infinity, hi = -Infinity, depth = 0
  for (let k = 0; k < hull.length; k += 2) {
    const vx = hull[k]! * c - hull[k + 1]! * s
    const vy = hull[k]! * s + hull[k + 1]! * c
    const t = vx * p.tx + vy * p.ty
    lo = Math.min(lo, t); hi = Math.max(hi, t)
    depth = Math.max(depth, -(vx * p.nx + vy * p.ny))
  }
  return { along: hi - lo, depth }
}

type PathPoint = { x: number; y: number; tx: number; ty: number; nx: number; ny: number }

/** Polylines joined into one list of segments [ax, ay, bx, by, …]; steep segments are skipped. */
function concatPaths(polys: Poly[]): number[] {
  const segs: number[] = []
  for (const p of polys) {
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k]!, ay = p[k + 1]!, bx = p[k + 2]!, by = p[k + 3]!
      const len = Math.hypot(bx - ax, by - ay)
      if (len < 1e-9 || Math.abs(bx - ax) / len < 0.5) continue
      segs.push(ax, ay, bx, by)
    }
  }
  return segs
}

function segsLength(segs: number[]): number {
  let total = 0
  for (let k = 0; k < segs.length; k += 4) total += Math.hypot(segs[k + 2]! - segs[k]!, segs[k + 3]! - segs[k + 1]!)
  return total
}

function pointAt(segs: number[], s: number): PathPoint {
  let left = s
  for (let k = 0; k < segs.length; k += 4) {
    const ax = segs[k]!, ay = segs[k + 1]!, bx = segs[k + 2]!, by = segs[k + 3]!
    const len = Math.hypot(bx - ax, by - ay)
    if (left <= len || k + 4 >= segs.length) return pathPoint(ax, ay, bx, by, len > 0 ? clamp(left / len, 0, 1) : 0)
    left -= len
  }
  return { x: 0, y: 0, tx: 1, ty: 0, nx: 0, ny: -1 }
}

/** Height of the floor polyline at x (first non-vertical segment covering it). */
export function groundYAt(ground: number[], x: number): number {
  for (let k = 0; k + 3 < ground.length; k += 2) {
    const ax = ground[k]!, bx = ground[k + 2]!
    if (bx === ax) continue
    if ((x >= ax && x <= bx) || (x >= bx && x <= ax)) {
      const u = (x - ax) / (bx - ax)
      return ground[k + 1]! + (ground[k + 3]! - ground[k + 1]!) * u
    }
  }
  return 0
}

/** Small local shuffles, so a smallest-first order doesn't look like a ruler. */
function jitterOrder(arr: number[], rand: () => number, window: number): void {
  for (let i = 0; i < arr.length; i++) {
    const j = Math.min(arr.length - 1, i + Math.floor(rand() * window))
    const t = arr[i]!; arr[i] = arr[j]!; arr[j] = t
  }
}

function shuffleInPlace<V>(arr: V[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = arr[i]!; arr[i] = arr[j]!; arr[j] = t
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
