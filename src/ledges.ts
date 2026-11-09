/**
 * One-way ground: the paths and the higher areas. Solid from above, open from
 * below and from the sides, so the ball can hop up through a path and land on
 * it, roll or fall off any edge, and never get wedged underneath one.
 *
 * Rapier has no one-way colliders, so a contact filter (physics hook) decides
 * every step which of the ball's colliders each path segment holds:
 *  - the core, once its lowest point is within `landBelow` × r of the surface,
 *    until it sinks `holdBelow` × r through (or rolls past an end, or ↓).
 *    At the edge of a gap the ball rests on the corner as it rolls across,
 *    and the far edge catches it while its centre is still `gapCatch` × r
 *    above it: a ball about 1.15 × as wide as the gap rolls over;
 *  - a lump (an insect stuck to the ball) the same way, using its own hull,
 *    but only while the core's centre is above the path. So the ball rolls on
 *    its lumps up here too, but a lump poking up through a path from below
 *    can't hook it and leave the ball hanging.
 * Insects sitting on a path are only solid to a ball that is up on that path
 * (its core's bottom clear of the surface), for the same reason.
 * After ↓ drops the ball through a path, that whole path lets it be until the
 * ball is clear of it, so rolling along just under it doesn't scoop the ball
 * back up.
 *
 * Needs `world.step(eventQueue, ledges.hooks)`: Rapier only runs hooks when an
 * event queue is passed.
 */
import { RAPIER, type Ball } from './physics'
import type { Ledge } from './levelgen'
import { T } from './tuning'

/** One of the ball's colliders: the core (no hull) or a lump with its hull in collider-local mm. */
export type BallPart = { collider: RAPIER.Collider; hull: number[] | null; reach: number }

export class Ledges {
  readonly hooks: RAPIER.PhysicsHooks
  private segOf = new Map<number, number>()
  private insectSeg = new Map<number, number>()
  /** Segment → handles of the ball colliders it holds up this step. */
  private active = new Map<number, Set<number>>()
  /** Segments the core is up on (its bottom clear of the surface): insects on them are solid. */
  private coreAbove = new Set<number>()
  /** Paths the ball has dropped through and is still tangled with. */
  private dropped = new Set<number>()
  private dirs: Array<{ tx: number; ty: number; len: number }>
  private byX: number[]
  private maxLen = 0

  constructor(
    world: RAPIER.World,
    body: RAPIER.RigidBody,
    readonly ledges: Ledge[],
    zoneRadius: (zone: number) => number,
    private core: () => RAPIER.Collider,
  ) {
    this.dirs = ledges.map((l) => {
      const len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0)
      this.maxLen = Math.max(this.maxLen, l.x1 - l.x0)
      return { tx: (l.x1 - l.x0) / len, ty: (l.y1 - l.y0) / len, len }
    })
    this.byX = ledges.map((_, i) => i).sort((a, b) => ledges[a]!.x0 - ledges[b]!.x0)
    ledges.forEach((l, i) => {
      // The solid under the walkable top tapers towards the bottom, so nothing
      // beside a segment's end can catch on a vertical end face.
      const depth = T.ledge.solidDepth * zoneRadius(l.zone)
      const inset = Math.min(0.8 * depth, 0.45 * (l.x1 - l.x0))
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array([l.x0, l.y0, l.x1, l.y1, l.x1 - inset, l.y1 + depth, l.x0 + inset, l.y0 + depth]))
      if (!desc) return
      const c = world.createCollider(desc.setFriction(1.1).setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS), body)
      this.segOf.set(c.handle, i)
    })
    this.hooks = {
      filterContactPair: (h1, h2) => {
        const s1 = this.segOf.get(h1)
        const seg = s1 ?? this.segOf.get(h2)
        if (seg !== undefined) return this.active.get(seg)?.has(s1 !== undefined ? h2 : h1) ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null
        const on = this.insectSeg.get(h1) ?? this.insectSeg.get(h2)
        if (on !== undefined) return this.coreAbove.has(on) ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null
        return RAPIER.SolverFlags.COMPUTE_IMPULSE
      },
      filterIntersectionPair: () => true,
    }
  }

  /** An insect collider sitting on segment `seg`: solid only to a ball above that path. */
  addInsect(collider: RAPIER.Collider, seg: number): void {
    collider.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
    this.insectSeg.set(collider.handle, seg)
  }

  removeInsect(handle: number): void {
    this.insectSeg.delete(handle)
  }

  /** Call before each world.step: decides which segments hold which of the ball's colliders. */
  update(ball: Ball, parts: BallPart[]): void {
    const p = ball.body.translation()
    const r = ball.r
    const coreH = this.core().handle
    // Lumps in world space, once.
    let reach = r
    const lumps = parts.filter((q) => q.hull).map((q) => {
      const t = q.collider.translation(), a = q.collider.rotation()
      const c = Math.cos(a), s = Math.sin(a), hull = q.hull!
      const w: number[] = []
      for (let k = 0; k < hull.length; k += 2) w.push(t.x + hull[k]! * c - hull[k + 1]! * s, t.y + hull[k]! * s + hull[k + 1]! * c)
      reach = Math.max(reach, Math.hypot(t.x - p.x, t.y - p.y) + q.reach)
      return { h: q.collider.handle, t, w, reach: q.reach }
    })
    const next = new Map<number, Set<number>>()
    const tangled = new Set<number>()
    this.coreAbove.clear()
    for (const i of this.near(p.x - reach, p.x + reach, p.y - reach, p.y + reach)) {
      const l = this.ledges[i]!
      const len = this.dirs[i]!.len
      const { s, d } = this.local(i, p.x, p.y)
      if (s < -reach || s > len + reach) continue
      if (this.dropped.has(l.path)) {
        if (d > -(reach + 0.2 * r)) tangled.add(l.path) // still overlapping it
        continue
      }
      if (d - r >= -T.ledge.landBelow * r) this.coreAbove.add(i)
      const prev = this.active.get(i)
      const held = new Set<number>()
      const was = prev?.has(coreH) ?? false
      // Past a gap edge the ball rests on the corner until it's a radius out; elsewhere a little way.
      const gapEdge = (s < 0 && l.gapLeft) || (s > len && l.gapRight)
      const out = s < 0 ? -s : s > len ? s - len : 0
      if (gapEdge) {
        if (out < r && (was ? d - r > -T.ledge.holdBelow * r : d >= T.ledge.gapCatch * r)) held.add(coreH)
      } else if (out < 0.3 * r && this.holds(was, d - r, r)) held.add(coreH)
      if (d >= 0.3 * r) {
        for (const q of lumps) {
          // Only a lump over the segment, never one beside its end.
          const at = this.local(i, q.t.x, q.t.y)
          if (at.s < 0 || at.s > len) continue
          let low = Infinity
          for (let k = 0; k < q.w.length; k += 2) low = Math.min(low, this.local(i, q.w[k]!, q.w[k + 1]!).d)
          if (this.holds(prev?.has(q.h) ?? false, low, q.reach)) held.add(q.h)
        }
      }
      if (held.size) next.set(i, held)
    }
    this.active = next
    // Done with a path dropped through once the ball is clear of it (moved away, or fallen past).
    for (const path of [...this.dropped]) if (!tangled.has(path)) this.dropped.delete(path)
  }

  /** ↓↓: fall through the path the ball is on; it won't pick the ball up again until the ball is clear of it. */
  dropThrough(ball: Ball): void {
    const p = ball.body.translation()
    let nearest = Infinity
    for (const i of this.active.keys()) { const { d } = this.local(i, p.x, p.y); if (d >= 0) nearest = Math.min(nearest, d) }
    if (nearest === Infinity) return
    for (const i of [...this.active.keys()]) {
      const { d } = this.local(i, p.x, p.y)
      if (d >= 0 && d < nearest + 0.6 * ball.r) { this.dropped.add(this.ledges[i]!.path); this.active.delete(i) }
    }
  }

  /** The segment the ball is resting on (the nearest holding one below its centre), or -1. */
  supporting(ball: Ball): number {
    const p = ball.body.translation()
    let best = -1, bestD = Infinity
    for (const i of this.active.keys()) {
      const { d } = this.local(i, p.x, p.y)
      if (d >= 0 && d < bestD) { best = i; bestD = d }
    }
    return best
  }

  isActive(handle: number): boolean {
    const i = this.segOf.get(handle)
    return i !== undefined && this.active.has(i)
  }

  isLedge(handle: number): boolean {
    return this.segOf.has(handle)
  }

  /** Hysteresis: start holding when barely through, keep holding until well through. */
  private holds(was: boolean, low: number, size: number): boolean {
    return was ? low > -T.ledge.holdBelow * size : low >= -T.ledge.landBelow * size
  }

  /** Segments whose box overlaps the given one. */
  private *near(x0: number, x1: number, y0: number, y1: number): Generator<number> {
    const order = this.byX, ledges = this.ledges
    let lo = 0, hi = order.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ledges[order[mid]!]!.x0 < x0 - this.maxLen) lo = mid + 1
      else hi = mid
    }
    for (let k = lo; k < order.length; k++) {
      const i = order[k]!, l = ledges[i]!
      if (l.x0 > x1) break
      if (l.x1 < x0 || Math.min(l.y0, l.y1) > y1 || Math.max(l.y0, l.y1) < y0) continue
      yield i
    }
  }

  /** Distance along a segment from its left end, and height above its top surface. */
  private local(i: number, x: number, y: number): { s: number; d: number } {
    const l = this.ledges[i]!, { tx, ty } = this.dirs[i]!
    const rx = x - l.x0, ry = y - l.y0
    // Up normal (y down): (ty, -tx).
    return { s: rx * tx + ry * ty, d: rx * ty - ry * tx }
  }
}
