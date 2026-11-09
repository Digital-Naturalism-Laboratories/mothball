/**
 * One-way ground with the real physics: lips gate by size, a lumpy ball rides
 * a path on its lumps, lumps can't hook a path from below, and the ball can
 * pass under or drop through.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { RAPIER, applyControl, createBall, createWorld, initPhysics, newControlState, scaleWorldToBall, type Ball } from './physics'
import { generateLevel, surfaceY, type Ledge } from './levelgen'
import { Ledges, type BallPart } from './ledges'
import { T } from './tuning'
import { mulberry32 } from './rng'
import type { PackBug } from './pack'

const DT = 1 / 60

beforeAll(async () => { await initPhysics() })

type Input = { dir: number; hop: boolean; down?: boolean }
type Sim = { ball: Ball; ledges: Ledges; parts: BallPart[]; run: (seconds: number, policy: (grounded: boolean) => Input, until?: () => boolean) => void }

/** Flat ground (top at y = 0) plus one-way segments; a ball of radius r at (x, y). */
function setup(segs: Ledge[], r: number, x: number, y = -r, zoneR = r): Sim {
  const world = createWorld()
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(1e5, 50 * r).setTranslation(0, 50 * r).setFriction(1.1), body)
  const ball = createBall(world, x, y, r)
  scaleWorldToBall(world, ball)
  const ledges = new Ledges(world, body, segs, () => zoneR, () => ball.core)
  const parts: BallPart[] = [{ collider: ball.core, hull: null, reach: r }]
  const events = new RAPIER.EventQueue(true)
  const ctrl = newControlState()
  let t = 0
  return {
    ball, ledges, parts,
    run(seconds, policy, until) {
      for (let i = 0; i < seconds / DT; i++) {
        const input = policy(ctrl.grounded)
        if (input.down) ledges.dropThrough(ball)
        applyControl(world, ball, parts.map((q) => q.collider), input, ctrl, DT)
        ledges.update(ball, parts)
        world.step(events, ledges.hooks)
        t += DT
        if (until?.()) return
      }
    },
  }
}

const seg = (x0: number, y0: number, x1: number, y1: number, path = 0): Ledge => ({ path, zone: 0, x0, y0, x1, y1 })

describe('one-way ground', () => {
  it('lets a bare ball hop onto a lip about 0.9 × its radius up, no higher', () => {
    const r = 4
    const lands = (h: number) => {
      const sim = setup([seg(-3 * r, -h, 3 * r, -h)], r, 0)
      sim.run(0.5, () => ({ dir: 0, hop: false }))
      let hopped = false
      sim.run(2, (g) => { const hop = g && !hopped; if (hop) hopped = true; return { dir: 0, hop } })
      return sim.ledges.supporting(sim.ball) >= 0
    }
    let lo = 0.3, hi = 1.5
    for (let k = 0; k < 12; k++) { const mid = (lo + hi) / 2; if (lands(mid * r)) lo = mid; else hi = mid }
    expect(lo).toBeGreaterThan(T.paths.hopReach * 0.95)
    expect(lo).toBeLessThan(T.paths.hopReach + 0.08)
  })

  it('passes a ball under a low path without hopping, and lets it drop through one with ↓', () => {
    const r = 4
    const under = setup([seg(10 * r, -1.2 * r, 20 * r, -1.2 * r)], r, 0)
    under.run(8, () => ({ dir: 1, hop: false }), () => under.ball.body.translation().x > 25 * r)
    expect(under.ball.body.translation().x).toBeGreaterThan(25 * r)

    const drop = setup([seg(-10 * r, -3 * r, 10 * r, -3 * r)], r, 0, -4.2 * r)
    drop.run(1, () => ({ dir: 0, hop: false }))
    expect(drop.ledges.supporting(drop.ball)).toBeGreaterThanOrEqual(0)
    drop.run(1.5, () => ({ dir: 0, hop: false, down: true }))
    expect(drop.ball.body.translation().y).toBeGreaterThan(-1.3 * r) // back on the ground
  })
})

describe('gaps', () => {
  /** Two stretches of path with a gap between, high above the ground; a ball rolls right off the first. */
  function cross(w: number, hopAtEdge: boolean): boolean {
    const r = 4, top = -8 * r
    const sim = setup([{ ...seg(-30 * r, top, 0, top), gapRight: true }, { ...seg(w, top, w + 30 * r, top, 1), gapLeft: true }], r, -20 * r, top - r)
    let hopped = false
    sim.run(6, (g) => {
      const x = sim.ball.body.translation().x
      const hop = hopAtEdge && g && !hopped && x > -1.2 * r
      if (hop) hopped = true
      return { dir: 1, hop }
    }, () => sim.ball.body.translation().x > w + 10 * r || sim.ball.body.translation().y > top + 2 * r)
    return sim.ball.body.translation().x > w + 10 * r && sim.ball.body.translation().y < top
  }

  it('lets a ball roll across a gap narrower than about 1.7 × its radius', () => {
    expect(cross(1.2 * 4, false)).toBe(true)
    expect(cross(1.6 * 4, false)).toBe(true)
  })

  it('drops a ball into a wider gap unless it hops', () => {
    expect(cross(2.6 * 4, false)).toBe(false)
    expect(cross(2.6 * 4, true)).toBe(true)
  })
})

describe('lumps on one-way ground', () => {
  function lumpy(segs: Ledge[], r: number, x: number, y: number, dirs: number[], out: number): Sim {
    const world = createWorld()
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(1e5, 50 * r).setTranslation(0, 50 * r).setFriction(1.1), body)
    const ball = createBall(world, x, y, r)
    scaleWorldToBall(world, ball)
    const parts: BallPart[] = [{ collider: ball.core, hull: null, reach: r }]
    for (const a of dirs) {
      const hull = [-0.5 * out * r, -0.12 * r, 0.5 * out * r, -0.12 * r, 0.5 * out * r, 0.12 * r, -0.5 * out * r, 0.12 * r]
      const d = r + 0.5 * out * r - 0.15 * r
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(hull))!.setTranslation(Math.cos(a) * d, Math.sin(a) * d).setRotation(a).setDensity(T.density)
      parts.push({ collider: world.createCollider(desc, ball.body), hull, reach: Math.hypot(0.5 * out * r, 0.12 * r) })
    }
    const ledges = new Ledges(world, body, segs, () => r, () => ball.core)
    const events = new RAPIER.EventQueue(true)
    const ctrl = newControlState()
    let t = 0
    return {
      ball, ledges, parts,
      run(seconds, policy, until) {
        for (let i = 0; i < seconds / DT; i++) {
          const input = policy(ctrl.grounded)
          applyControl(world, ball, parts.map((q) => q.collider), input, ctrl, DT)
          ledges.update(ball, parts)
          world.step(events, ledges.hooks)
          t += DT
          if (until?.()) return
        }
      },
    }
  }

  it('rolls a lumpy ball along a path on its lumps, without sinking through', () => {
    const r = 4, top = -6 * r
    const sim = lumpy([seg(-40 * r, top, 40 * r, top)], r, -30 * r, top - 3 * r, [0, 2.1, 4.2], 0.8)
    let highest = 0, lowest = Infinity
    sim.run(6, () => ({ dir: 1, hop: false }), () => {
      const above = top - sim.ball.body.translation().y
      highest = Math.max(highest, above); lowest = Math.min(lowest, above)
      return false
    })
    expect(highest).toBeGreaterThan(1.3 * r) // up on a lump at times
    expect(lowest).toBeGreaterThan(0.7 * r) // never through the path
    expect(sim.ball.body.translation().x).toBeGreaterThan(-20 * r) // and it got somewhere
  })

  it('lets a ball standing tall on spines sneak onto a lip a bare ball of its size can\'t reach', () => {
    const r = 4, top = -1.3 * r // beyond a bare ball's hop, within reach standing on two spines
    const hopOnto = (spines: number[]) => {
      // Start under the path: a bare ball on the ground, a spiky one standing on its two spines.
      const sim = lumpy([seg(-10 * r, top, 10 * r, top)], r, 0, spines.length ? -1.75 * r : -1.02 * r, spines, 1.0)
      sim.run(1, () => ({ dir: 0, hop: false }))
      let hopped = false
      sim.run(3, (g) => { const hop = g && !hopped; if (hop) hopped = true; return { dir: 0, hop } })
      return sim.ledges.supporting(sim.ball) >= 0
    }
    expect(hopOnto([])).toBe(false)
    expect(hopOnto([Math.PI / 2 - 0.5, Math.PI / 2 + 0.5])).toBe(true)
  })

  it('after dropping through a low path, rolling along under it does not scoop the ball back up', () => {
    const r = 4, top = -0.35 * r // a lip pad just above the ground
    const sim = lumpy([seg(-12 * r, top, 12 * r, top)], r, -8 * r, top - 1.6 * r, [0, 2.1, 4.2], 0.6)
    sim.run(1, () => ({ dir: 0, hop: false }))
    expect(sim.ledges.supporting(sim.ball)).toBeGreaterThanOrEqual(0)
    sim.ledges.dropThrough(sim.ball)
    let backOn = false
    sim.run(10, () => ({ dir: 1, hop: false }), () => {
      if (sim.ball.body.translation().x < 10 * r && sim.ledges.supporting(sim.ball) >= 0) backOn = true
      return sim.ball.body.translation().x > 14 * r
    })
    expect(backOn).toBe(false)
    expect(sim.ball.body.translation().x).toBeGreaterThan(10 * r)
  })

  it("won't let a lump poking up through a path hook the ball from below", () => {
    const r = 4, top = -2.3 * r // above a hop for the core, but a lump pointing up reaches past it
    const sim = lumpy([seg(-10 * r, top, 10 * r, top)], r, 0, -r, [-Math.PI / 2], 1.1)
    sim.run(0.6, () => ({ dir: 0, hop: false }))
    let hopped = false
    sim.run(3, (g) => { const hop = g && !hopped; if (hop) hopped = true; return { dir: 0, hop } })
    expect(hopped).toBe(true)
    expect(sim.ball.body.translation().y).toBeGreaterThan(-1.6 * r) // back down, not hanging
  })
})

describe('a generated connector', () => {
  function bugs(n: number): PackBug[] {
    const rand = mulberry32(3)
    return Array.from({ length: n }, (_, i) => {
      const length = Math.exp(Math.log(0.5) + rand() * (Math.log(80) - Math.log(0.5)))
      return {
        id: `b${i}`, label: 'x', rank: 'order', order: 'Lepidoptera', areaMm2: length * length * 0.4, mmPerPx: length / 100,
        atlas: 0, x: 0, y: 0, w: 100, h: 60, hull: [-50, -30, 50, -30, 50, 30, -50, 30],
      }
    })
  }
  const level = generateLevel(bugs(1500), 1)

  /** A ball of radius r starts under zone 1's lip, hops, then rolls up the ramp. Does it reach the area? */
  function tryGate(r: number): boolean {
    const lip = level.lips.find((l) => l.kind === 'connector' && l.zone === 1)!
    const area = level.zones[1]!
    const groundY = surfaceY(level.ground, lip.x) ?? 0
    // Just this connector and area, over flat ground at the lip's floor height.
    const segs = level.ledges.filter((l) => l.path === lip.path || l.path === area.path).map((l) => ({ ...l, y0: l.y0 - groundY, y1: l.y1 - groundY }))
    const sim = setup(segs, r, lip.x, -r, level.zones[1]!.radius)
    const dir = Math.sign(area.arrive.x - lip.x)
    sim.run(0.5, () => ({ dir: 0, hop: false }))
    let hops = 0
    let onArea = false
    sim.run(40, (g) => {
      const on = sim.ledges.supporting(sim.ball)
      if (on < 0 && g && hops < 3) { hops++; return { dir: 0, hop: true } } // try to get on
      return { dir: on >= 0 ? dir : 0, hop: false }
    }, () => {
      const on = sim.ledges.supporting(sim.ball)
      onArea = on >= 0 && segs[on]!.path === area.path
      return onArea
    })
    return onArea
  }

  it('takes a ball of the size the zone needs all the way up to the new area', () => {
    expect(tryGate(level.zones[1]!.needR)).toBe(true)
  })

  it('keeps a bare ball a quarter smaller off it', () => {
    expect(tryGate(0.75 * level.zones[1]!.needR)).toBe(false)
  })
})
