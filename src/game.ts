/**
 * One night of Mothball: physics, insects, the ball, camera and clock.
 *
 * Insects are in one of these states:
 *   rest  – on the ground or a path; a solid collider (some crawl, all twitch now and then)
 *   perch – on a plant stalk or a path; no collider, picked up by touch
 *   fly   – in the air; no physics. Near the light they circle it (insects keep
 *           their back to a light, so they orbit instead of flying in), dip into
 *           reach now and then, and eventually wander off
 *   stuck – on the ball; a sprite in the ball, plus a collider shaped like its
 *           whole silhouette (legs and all) while it pokes out. Insects caught
 *           flying hit the lamp head first and stick out like spines. Once
 *           buried under newer ones an insect is painted into the ball's
 *           picture (a render texture), so the ball stays packed all the way in.
 * Lit insects take off towards the light. Hard hits make the ball's newest
 * lumps fly off; the flood light shakes off whatever juts out most.
 *
 * The higher areas and the paths are one-way ground (src/ledges.ts).
 */
import { Application, Container, Graphics, ImageSource, Rectangle, RenderTexture, Sprite, Texture } from 'pixi.js'
import { T } from './tuning'
import { generateLevel, groundYAt, plantPoint, surfaceY, type BugInfo, type GeneratedLevel, type Path } from './levelgen'
import { Ledges, type BallPart } from './ledges'
import { hullReach } from './silhouette'
import type { LoadedPack, PackBug } from './pack'
import { RAPIER, applyControl, clamp, createBall, createWorld, newControlState, scaleWorldToBall, type Ball, type ControlState } from './physics'
import { Darkness } from './darkness'
import { Hud, formatMm } from './hud'
import { mulberry32, range } from './rng'

const DT = 1 / 60

type FlyState = {
  mode: 'idle' | 'orbit' | 'flee'
  hx: number
  hy: number
  wander: number
  phase: number
  t: number
  theta: number
  orbitR: number
  dir: number
  speed: number
  vx: number
  vy: number
  until: number
  /** Circling a ball it's too big to stick to: keeps its distance. */
  far?: boolean
}

type Crawl = { tx: number; ty: number; amp: number; freq: number }

type Bug = {
  index: number
  def: PackBug
  info: BugInfo
  zone: number
  sprite: Sprite
  /** gone: zapped by the flood light to free a stuck ball; out of the game. */
  mode: 'rest' | 'perch' | 'fly' | 'stuck' | 'gone'
  /** Home pose (rest / perch). */
  x: number
  y: number
  angle: number
  obstacle: boolean
  collider: RAPIER.Collider | null
  crawl: Crawl | null
  phase: number
  fly: FlyState | null
  regrabAt: number
  /** On this one-way path (sitting on segment `seg`, if solid). */
  path: number | null
  seg: number | null
  /** Whole-silhouette hull (mm, legs and all): its shape once stuck to the ball. */
  lumpHull: number[]
  /** Farthest point of that hull from the insect's centre (mm). */
  reach: number
  /** Painted into the ball's picture (its own sprite is gone). */
  baked: boolean
}

export type NightResult = {
  diameterMm: number
  collected: Bug[]
  total: number
  kinds: Array<{ label: string; count: number }>
  biggest: Bug | null
}

export class Game {
  private world = createWorld()
  private events = new RAPIER.EventQueue(true)
  private gen: GeneratedLevel
  private bugs: Bug[] = []
  /** Ground and plant insects, sorted by home x (for on-screen range lookups). */
  private sitters: Bug[] = []
  private ball: Ball
  private ctrl: ControlState = newControlState()
  private stuck: Bug[] = []
  /** Collider handle → insect (ground sitters and lumps). */
  private byCollider = new Map<number, Bug>()
  private ballHandles = new Set<number>()
  private staticBody: RAPIER.RigidBody
  private ledges: Ledges
  /** The zone whose ground the ball was last on. */
  private zoneNow = 0
  private rand = mulberry32(7)

  private worldLayer = new Container()
  private bugLayer = new Container()
  private flyLayer = new Container()
  private ballLayer = new Container()
  private ballSprite = new Container()
  private coreSprite: Sprite
  /** Buried insects, painted in (see flushBake). */
  private bakeSprite = new Sprite()
  private bakeRT: RenderTexture | null = null
  /** Half the width of the ball picture, mm. */
  private bakeExtent = 0
  private bakeQueue: Bug[] = []
  private bakeRoot = new Container()
  /** The lamp shining through the packed insects. */
  private glowSprite: Sprite
  private debugLayer: Graphics | null = null

  private keys = new Set<string>()
  private hopQueuedAt = -1
  /** ↓↓ (double tap): drop through the path underfoot (buffered briefly, like a hop). */
  private dropQueuedAt = -1
  private lastDownAt = -10
  private time = 0
  private acc = 0
  private paused = false
  private over = false
  private camX = 0
  private camY = 0
  private camScale = 1
  /** The scale actually drawn: camScale, pulled out while the flood light is on. */
  private viewScale = 1
  private floodZoomK = 0
  private zoomTarget = 1
  /** When the flood light can fire again. */
  private floodReadyAt = 0
  /** After a flash: if the ball still hasn't moved by `at`, zap whatever it's stuck on. */
  private unstick: { at: number; x: number; y: number } | null = null
  private floodUntil = -1
  private lastKnock = -10
  private kindsSeen = new Map<string, number>()
  private nightStart: number
  private nightEnd: number
  private cleanup: Array<() => void> = []
  /** Smoothed JS milliseconds per frame, by part (for scripts/playtest.ts). */
  private perf = { step: 0, sitters: 0, flyers: 0, render: 0 }

  constructor(
    private app: Application,
    private pack: LoadedPack,
    private darkness: Darkness,
    private hud: Hud,
    private onDawn: (result: NightResult) => void,
    debug = false,
    private nightSeconds: number = T.nightSeconds,
  ) {
    this.gen = generateLevel(pack.level.bugs, 1)
    const times = pack.level.bugs.map((b) => b.t).filter((t): t is number => typeof t === 'number')
    const [tMin, tMax] = minMax(times)
    this.nightStart = times.length ? Math.floor(tMin / 15) * 15 - 15 : 540
    this.nightEnd = times.length ? Math.ceil(tMax / 15) * 15 + 15 : 1050

    app.stage.addChild(this.worldLayer)
    this.worldLayer.addChild(this.drawTerrain(), this.bugLayer, this.ballLayer, this.flyLayer)
    this.ballLayer.addChild(this.ballSprite)
    this.coreSprite = new Sprite(coreTexture())
    this.coreSprite.anchor.set(0.5)
    this.bakeSprite.anchor.set(0.5)
    this.bakeSprite.tint = 0xd4caf2 // a touch darker and bluer: deeper in
    this.glowSprite = new Sprite(glowTexture())
    this.glowSprite.anchor.set(0.5)
    this.glowSprite.blendMode = 'add'
    this.ballSprite.addChild(this.coreSprite, this.bakeSprite, this.glowSprite)
    if (debug) { this.debugLayer = new Graphics(); this.worldLayer.addChild(this.debugLayer) }

    this.staticBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    this.buildGround()
    this.ledges = new Ledges(this.world, this.staticBody, this.gen.ledges, (z) => this.gen.zones[z]!.radius, () => this.ball.core)
    this.spawnBugs()

    const { x, y } = this.gen.spawn
    this.ball = createBall(this.world, x, y, T.startRadius)
    this.ballHandles.add(this.ball.core.handle)
    this.onBallResized()
    this.camX = x; this.camY = y
    this.zoomTarget = this.camScale = this.viewScale = this.baseScale()

    this.bindInput()
    this.hud.show(true)
    this.hud.clearFeed()
    const tick = () => this.frame(Math.min(0.1, this.app.ticker.deltaMS / 1000))
    this.app.ticker.add(tick)
    this.cleanup.push(() => this.app.ticker.remove(tick))
  }

  destroy(): void {
    for (const fn of this.cleanup) fn()
    this.app.stage.removeChild(this.worldLayer)
    this.worldLayer.destroy({ children: true })
    this.bakeRT?.destroy(true)
    this.bakeRoot.destroy()
    this.world.free()
    this.hud.show(false)
  }

  // ─── setup ────────────────────────────────────────────────────────────────

  private drawTerrain(): Container {
    const layer = new Container()
    const g = new Graphics()
    const pts = this.gen.ground
    const [minX, maxX] = minMax(pts.filter((_, i) => i % 2 === 0))
    const areas = this.gen.paths.filter((p) => p.kind === 'area')
    // Trunks holding up the higher areas, far behind everything.
    for (const a of areas) {
      const R = this.gen.zones[a.zone]!.radius
      const x0 = a.points[0]!, x1 = a.points[a.points.length - 2]!
      for (const f of [0.22, 0.68]) {
        const x = x0 + (x1 - x0) * f, top = surfaceY(a.points, x) ?? 0, foot = groundYAt(pts, x)
        g.poly([x - 0.5 * R, top, x + 0.5 * R, top, x + 1.1 * R, foot, x - 1.1 * R, foot]).fill({ color: 0x15111b, alpha: 0.9 })
      }
    }
    // Plants, so the ground covers their roots.
    for (const plant of this.gen.plants) {
      const R = this.gen.zones[plant.zone]!.radius
      const tip = plantPoint(plant, 1), mid = plantPoint(plant, 0.5)
      g.moveTo(plant.x, plant.y + R)
      g.quadraticCurveTo(2 * mid.x - (plant.x + tip.x) / 2, 2 * mid.y - (plant.y + tip.y) / 2, tip.x, tip.y)
      g.stroke({ width: plant.width, color: 0x2c4a44, alpha: 0.9, cap: 'round' })
      const leaves = plant.big ? [0.22, 0.34, 0.46, 0.58, 0.7, 0.8, 0.9] : [0.35, 0.6, 0.8]
      leaves.forEach((f, n) => {
        const at = plantPoint(plant, f)
        const side = n % 2 ? 1 : -1
        const a = at.angle + side * 0.9
        const len = R * (1.1 - f * 0.5) * (plant.big ? 1.7 : 1), w = len * 0.28
        const ex = at.x + Math.cos(a) * len, ey = at.y + Math.sin(a) * len
        const mx = (at.x + ex) / 2, my = (at.y + ey) / 2
        const nx = -Math.sin(a) * w, ny = Math.cos(a) * w
        g.poly([at.x, at.y, mx + nx, my + ny, ex, ey, mx - nx, my - ny]).fill({ color: 0x2c4a44, alpha: 0.85 })
      })
    }
    // The forest floor, rim-lit where zone 0 is.
    g.poly([...pts, maxX, this.gen.bottomY, minX, this.gen.bottomY]).fill({ color: 0x110d18 })
    const z0 = this.gen.zones[0]!
    g.poly(pts.slice(2, -2), false).stroke({ width: z0.radius * 0.18, color: zoneColor(0), alpha: 0.45, join: 'round' })
    const home: number[] = []
    for (let k = 0; k < pts.length; k += 2) if (pts[k]! >= z0.x0 && pts[k]! <= z0.x1) home.push(pts[k]!, pts[k + 1]!)
    if (home.length >= 4) g.poly(home, false).stroke({ width: z0.radius * 0.18, color: zoneColor(0), alpha: 0.85, join: 'round' })
    // Areas and paths: thick branches, rim-lit in their zone's colour.
    for (const p of this.gen.paths) drawPath(g, p, this.gen.zones[p.zone]!.radius)
    layer.addChild(g)
    return layer
  }

  /**
   * Solid ground: one convex slab under each ground segment, plus end walls.
   * (A bare polyline has no inside, so a thin lump could poke through it and
   * hook the ball from underneath.)
   */
  private buildGround(): void {
    const g = this.gen.ground
    const add = (desc: RAPIER.ColliderDesc | null) => { if (desc) this.world.createCollider(desc.setFriction(1.1), this.staticBody) }
    for (let k = 0; k + 3 < g.length; k += 2) {
      const ax = g[k]!, ay = g[k + 1]!, bx = g[k + 2]!, by = g[k + 3]!
      if (Math.abs(bx - ax) < 1e-6) continue // walls are the end cuboids
      const depth = 6 * Math.max(this.gen.zones[0]!.radius, Math.abs(bx - ax))
      const bottom = Math.max(ay, by) + depth
      add(RAPIER.ColliderDesc.convexHull(new Float32Array([ax, ay, bx, by, bx, bottom, ax, bottom])))
    }
    const topY = g[1]!, firstX = g[0]!, lastX = g[g.length - 2]!
    const half = (this.gen.bottomY - topY) / 2, midY = (this.gen.bottomY + topY) / 2
    const w = 20 * this.gen.zones[this.gen.zones.length - 1]!.radius
    add(RAPIER.ColliderDesc.cuboid(w, half).setTranslation(firstX - w, midY))
    add(RAPIER.ColliderDesc.cuboid(w, half).setTranslation(lastX + w, midY))
  }

  private spawnBugs(): void {
    const sources = this.pack.atlases.map((bitmap) => new ImageSource({ resource: bitmap, autoGenerateMipmaps: true }))
    const bugs = this.pack.level.bugs
    for (const p of this.gen.placements) {
      const def = bugs[p.bug]!
      const tex = new Texture({ source: sources[def.atlas]!, frame: new Rectangle(def.x, def.y, def.w, def.h) })
      const sprite = new Sprite(tex)
      sprite.cullable = true
      sprite.anchor.set(0.5)
      sprite.scale.set(def.mmPerPx)
      sprite.position.set(p.x, p.y)
      sprite.rotation = p.angle
      const info = this.gen.info[p.bug]!
      const lumpHull = (this.pack.silhouettes[p.bug] ?? def.hull).map((v) => v * def.mmPerPx)
      const bug: Bug = {
        index: p.bug, def, info, zone: p.zone, sprite, mode: p.mode, x: p.x, y: p.y, angle: p.angle,
        obstacle: !!p.obstacle, collider: null, crawl: null, phase: this.rand() * 100, fly: null, regrabAt: 0,
        path: p.path ?? null, seg: p.seg ?? null, lumpHull, reach: Math.max(hullReach(lumpHull), info.length / 2), baked: false,
      }
      if (p.mode === 'rest') {
        bug.collider = this.world.createCollider(this.hullDesc(bug).setTranslation(p.x, p.y).setRotation(p.angle), this.staticBody)
        this.byCollider.set(bug.collider.handle, bug)
        if (bug.seg != null) this.ledges.addInsect(bug.collider, bug.seg)
        if (!bug.obstacle && p.tx != null && this.rand() < 0.4) {
          bug.crawl = { tx: p.tx, ty: p.ty ?? 0, amp: info.length * range(this.rand, 0.5, 1.2), freq: range(this.rand, 0.2, 0.5) }
        }
        this.bugLayer.addChild(sprite)
        this.sitters.push(bug)
      } else if (p.mode === 'perch') {
        this.bugLayer.addChild(sprite)
        this.sitters.push(bug)
      } else {
        bug.fly = this.newFlyState(p.x, p.y, this.gen.zones[p.zone]!.radius)
        this.flyLayer.addChild(sprite)
      }
      this.bugs.push(bug)
    }
    this.sitters.sort((a, b) => a.x - b.x)
  }

  private newFlyState(x: number, y: number, zoneR: number): FlyState {
    return {
      mode: 'idle', hx: x, hy: y, wander: range(this.rand, 1.5, 5) * zoneR, phase: this.rand() * 100, t: 0,
      theta: 0, orbitR: 0, dir: 1, speed: 1, vx: 0, vy: 0, until: 0,
    }
  }

  /** Collider for an insect: lying on a surface (body only), or stuck to the ball (whole silhouette). */
  private hullDesc(bug: Bug, onBall = false): RAPIER.ColliderDesc {
    const hull = onBall ? bug.lumpHull : bug.info.hull
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(hull)) ?? RAPIER.ColliderDesc.ball(bug.info.length / 2)
    return desc.setFriction(0.9).setDensity(T.density).setRestitution(0)
  }

  private bindInput(): void {
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', 'a', 'd', 'w', 's'].includes(k)) e.preventDefault()
      if (!e.repeat && (k === 'arrowup' || k === ' ' || k === 'w')) this.hopQueuedAt = this.time
      if (!e.repeat && (k === 'arrowdown' || k === 's')) this.tapDown()
      if (!e.repeat && (k === 'f' || k === 'control')) this.flood()
      if (!e.repeat && (k === 'p' || k === 'escape')) this.paused = !this.paused
      this.keys.add(k)
    }
    const up = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase())
    const blur = () => this.keys.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    this.cleanup.push(() => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    })
  }

  /** Touch controls call these. */
  setTouch(dir: number, hop: boolean, down = false): void {
    this.keys.delete('arrowleft'); this.keys.delete('arrowright')
    if (dir < 0) this.keys.add('arrowleft')
    if (dir > 0) this.keys.add('arrowright')
    if (hop) this.hopQueuedAt = this.time
    if (down) this.tapDown()
  }

  /** Dropping through a path takes two taps of ↓, so a stray press can't send you down a long way. */
  private tapDown(): void {
    if (this.time - this.lastDownAt < T.ledge.doubleTap) { this.dropQueuedAt = this.time; this.lastDownAt = -10 }
    else this.lastDownAt = this.time
  }

  // ─── loop ─────────────────────────────────────────────────────────────────

  private frame(dt: number): void {
    if (this.over) return
    if (!this.paused) {
      this.time += dt
      this.acc += dt
      let steps = 0
      const t0 = performance.now()
      while (this.acc >= DT && steps < 4) {
        this.step()
        this.acc -= DT
        steps++
      }
      if (steps === 4) this.acc = 0
      const t1 = performance.now()
      this.updateSitters(dt)
      const t2 = performance.now()
      this.updateFlyers(dt)
      const t3 = performance.now()
      this.track('step', t1 - t0); this.track('sitters', t2 - t1); this.track('flyers', t3 - t2)
    }
    const t4 = performance.now()
    this.render(dt)
    this.track('render', performance.now() - t4)
    if (this.time >= this.nightSeconds && !this.over) this.endNight()
  }

  private step(): void {
    const dir = (this.keys.has('arrowright') || this.keys.has('d') ? 1 : 0) - (this.keys.has('arrowleft') || this.keys.has('a') ? 1 : 0)
    const hop = this.hopQueuedAt >= 0 && this.time - this.hopQueuedAt < 0.15
    if (this.dropQueuedAt >= 0 && this.time - this.dropQueuedAt < 0.15 && this.ledges.supporting(this.ball) >= 0) {
      this.ledges.dropThrough(this.ball)
      this.dropQueuedAt = -1
    }
    applyControl(this.world, this.ball, this.ballColliders(), { dir, hop }, this.ctrl, DT)
    if (hop && this.ctrl.hopCooldown > 0) this.hopQueuedAt = -1
    this.ledges.update(this.ball, this.ballParts())
    this.world.step(this.events, this.ledges.hooks)
    if (this.unstick && this.time >= this.unstick.at) this.checkUnstuck()

    const on = this.ledges.supporting(this.ball)
    if (on >= 0) {
      const l = this.gen.ledges[on]!
      this.zoneNow = this.gen.paths[l.path]!.kind === 'connector' ? l.zone - 1 : l.zone // a ramp starts from the zone below
    }
    else if (this.ctrl.grounded) {
      const p = this.ball.body.translation()
      if (groundYAt(this.gen.ground, p.x) - p.y < 3 * this.ball.r) this.zoneNow = 0 // down on the forest floor
    }

    // Hard hits shake insects loose.
    let hardest = 0
    this.events.drainContactForceEvents((ev) => {
      if (this.ballHandles.has(ev.collider1()) !== this.ballHandles.has(ev.collider2())) {
        hardest = Math.max(hardest, ev.totalForceMagnitude())
      }
    })
    this.events.drainCollisionEvents(() => {})
    if (hardest > 0) this.knock(hardest)

    // Pick up the ground insects the ball is touching and can lift.
    const pickups = new Set<Bug>()
    for (const c of this.ballColliders()) {
      this.world.contactPairsWith(c, (other) => {
        const bug = this.byCollider.get(other.handle)
        if (!bug || bug.mode !== 'rest' || pickups.has(bug) || !this.canLift(bug)) return
        this.world.contactPair(c, other, (m) => { if (m.numContacts() > 0) pickups.add(bug) })
      })
    }
    for (const bug of pickups) this.attach(bug)
  }

  private *ballColliders(): Generator<RAPIER.Collider> {
    yield this.ball.core
    for (const bug of this.stuck) if (bug.collider) yield bug.collider
  }

  private ballParts(): BallPart[] {
    const parts: BallPart[] = [{ collider: this.ball.core, hull: null, reach: this.ball.r }]
    for (const bug of this.stuck) if (bug.collider) parts.push({ collider: bug.collider, hull: bug.lumpHull, reach: bug.reach })
    return parts
  }

  private canLift(bug: Bug): boolean {
    return bug.info.length < T.collectRatio * this.ball.r && this.time >= bug.regrabAt
  }

  // ─── sitters ──────────────────────────────────────────────────────────────

  /** Animates on-screen ground and plant insects; picks up perched ones; lit ones may take off. */
  private updateSitters(dt: number): void {
    const bp = this.ball.body.translation()
    const r = this.ball.r
    const light = T.lightRadius * r
    const half = (window.innerWidth / 2 / this.viewScale) * 1.2
    const t = this.time
    const toAttach: Bug[] = []
    const toLaunch: Array<[Bug, 'orbit' | 'flee']> = []
    for (let i = lowerBound(this.sitters, this.camX - half); i < this.sitters.length; i++) {
      const bug = this.sitters[i]!
      if (bug.x > this.camX + half) break
      if (bug.mode !== 'rest' && bug.mode !== 'perch') continue
      const L = bug.info.length
      // Now and then a short twitch.
      const twitch = 0.09 * Math.sin(t * 11 + bug.phase) * Math.max(0, Math.sin(t * 0.6 + bug.phase)) ** 12
      bug.sprite.rotation = bug.angle + twitch
      let px = bug.x, py = bug.y
      if (bug.mode === 'rest' && bug.crawl) {
        const off = bug.crawl.amp * Math.sin(t * bug.crawl.freq + bug.phase)
        px += bug.crawl.tx * off; py += bug.crawl.ty * off
        bug.collider?.setTranslationWrtParent({ x: px, y: py })
      } else if (bug.mode === 'perch' && bug.path == null) {
        px += Math.sin(t * 1.1 + bug.phase) * 0.06 * L
      }
      bug.sprite.position.set(px, py)

      const d = Math.hypot(px - bp.x, py - bp.y)
      if (bug.mode === 'perch' && d < this.catchRadius(L)) {
        if (this.canLift(bug)) toAttach.push(bug)
        else toLaunch.push([bug, 'flee']) // bumped but too big: startled
        continue
      }
      const takeoff = bug.path != null ? T.takeoff.path : T.takeoff[bug.mode]
      if (!bug.obstacle && d < light * 0.9 && this.rand() < takeoff * dt) toLaunch.push([bug, 'orbit'])
    }
    for (const bug of toAttach) this.attach(bug)
    for (const [bug, how] of toLaunch) this.takeOff(bug, how)
  }

  /** A ground or plant insect lifts off: towards the light, or away from it. */
  private takeOff(bug: Bug, how: 'orbit' | 'flee'): void {
    if (bug.collider) {
      this.byCollider.delete(bug.collider.handle)
      this.ledges.removeInsect(bug.collider.handle)
      this.world.removeCollider(bug.collider, true)
      bug.collider = null
    }
    bug.mode = 'fly'
    bug.sprite.removeFromParent()
    this.flyLayer.addChild(bug.sprite)
    bug.fly = this.newFlyState(bug.sprite.x, bug.sprite.y, this.gen.zones[bug.zone]!.radius)
    if (how === 'orbit') this.startOrbit(bug)
    else this.startFlee(bug, 1)
  }

  // ─── sticking ─────────────────────────────────────────────────────────────

  /**
   * Moves an insect onto the ball where it touched, and grows the ball. Ground
   * insects stick lying flat, where they touched (even on top of other insects).
   * Flyers and perchers often hit the lamp head first and stand out like spines.
   */
  private attach(bug: Bug): void {
    const { x, y, angle: worldAngle } = this.worldPose(bug)
    const fromGround = bug.mode === 'rest'
    if (bug.collider) {
      this.byCollider.delete(bug.collider.handle)
      this.ledges.removeInsect(bug.collider.handle)
      this.world.removeCollider(bug.collider, false)
      bug.collider = null
    }
    const r = this.ball.r, L = bug.info.length
    const bp = this.ball.body.translation(), ba = this.ball.body.rotation()
    const dx = x - bp.x, dy = y - bp.y
    const d = Math.hypot(dx, dy) || 1
    const ux = dx / d, uy = dy / d
    let dist: number, angle = worldAngle
    if (!fromGround && this.rand() < T.headFirst) {
      // Long axis along the radius, head in.
      angle = Math.atan2(uy, ux) - bug.info.axis + (this.rand() < 0.5 ? Math.PI : 0) + range(this.rand, -0.25, 0.25)
      dist = r + 0.25 * L
    } else {
      dist = clamp(d - 0.1 * L, r, r + T.stickOut * L)
    }
    const c = Math.cos(-ba), s = Math.sin(-ba)
    const lx = (ux * c - uy * s) * dist
    const ly = (ux * s + uy * c) * dist
    const la = angle - ba

    bug.mode = 'stuck'
    bug.fly = null
    bug.sprite.removeFromParent()
    bug.sprite.position.set(lx, ly)
    bug.sprite.rotation = la
    bug.sprite.scale.set(bug.def.mmPerPx)
    this.ballSprite.addChild(bug.sprite)
    this.stuck.push(bug)

    if (this.poke(bug) > T.lumpPoke * r && 2 * bug.reach >= T.lumpMinLength * r) {
      bug.collider = this.world.createCollider(
        this.hullDesc(bug, true).setTranslation(lx, ly).setRotation(la)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(this.knockThreshold()),
        this.ball.body,
      )
      this.byCollider.set(bug.collider.handle, bug)
      this.ballHandles.add(bug.collider.handle)
    }

    this.ball.area += T.growth * bug.info.area
    this.onBallResized()

    const n = (this.kindsSeen.get(bug.def.label) ?? 0) + 1
    this.kindsSeen.set(bug.def.label, n)
    this.hud.pickup(`${n === 1 ? '★ ' : ''}${bug.def.label} · ${formatMm(L)}`)
  }

  /** How far a stuck insect reaches beyond the core (legs and all). */
  private poke(bug: Bug): number {
    return Math.hypot(bug.sprite.x, bug.sprite.y) + bug.reach - this.ball.r
  }

  /** Recompute the core after growing or shrinking; drop lumps it swallowed; hide the buried. */
  private onBallResized(): void {
    const ball = this.ball
    ball.r = Math.sqrt(ball.area / Math.PI)
    ball.core.setRadius(ball.r)
    ball.core.setContactForceEventThreshold(this.knockThreshold())
    scaleWorldToBall(this.world, ball)
    this.coreSprite.width = this.coreSprite.height = ball.r * 2.3
    this.glowSprite.width = this.glowSprite.height = ball.r * 1.9

    for (const b of this.stuck) {
      if (b.baked) continue
      const p = this.poke(b)
      if (b.collider && (p < T.lumpPoke * ball.r || 2 * b.reach < 0.75 * T.lumpMinLength * ball.r)) this.dropLumpCollider(b)
      if (p <= -T.bakeDepth * ball.r) { b.baked = true; this.bakeQueue.push(b) }
    }
    const lumps = this.stuck.filter((b) => b.collider && !b.baked).sort((a, b) => this.poke(a) - this.poke(b))
    while (lumps.length > T.maxLumps) this.dropLumpCollider(lumps.shift()!)
  }

  /**
   * Paints the buried insects into the ball's picture and drops their sprites.
   * The picture is a square render texture centred on the ball; when the ball
   * outgrows it, it is redrawn at half scale into a new one twice as wide.
   */
  private flushBake(): void {
    if (!this.bakeQueue.length) return
    const renderer = this.app.renderer
    const N = T.bakePx
    let need = 0
    for (const b of this.bakeQueue) need = Math.max(need, Math.hypot(b.sprite.x, b.sprite.y) + b.reach)
    if (!this.bakeRT || need > this.bakeExtent) {
      let extent = this.bakeExtent || 4 * T.startRadius
      while (extent < need) extent *= 2
      const rt = RenderTexture.create({ width: N, height: N, resolution: 1, antialias: false, autoGenerateMipmaps: true, scaleMode: 'linear' })
      renderer.render({ container: this.bakeRoot, target: rt, clear: true, clearColor: [0, 0, 0, 0] })
      if (this.bakeRT) {
        const old = new Sprite(this.bakeRT)
        old.anchor.set(0.5)
        old.position.set(N / 2, N / 2)
        old.scale.set(this.bakeExtent / extent)
        this.bakeRoot.addChild(old)
        renderer.render({ container: this.bakeRoot, target: rt, clear: false })
        this.bakeRoot.removeChildren()
        old.destroy()
        this.bakeRT.destroy(true)
      }
      this.bakeRT = rt
      this.bakeExtent = extent
      this.bakeSprite.texture = rt
      this.bakeSprite.scale.set((2 * extent) / N)
    }
    const k = N / (2 * this.bakeExtent) // texture px per mm
    for (const b of this.bakeQueue) {
      const s = new Sprite(b.sprite.texture)
      s.anchor.set(0.5)
      s.position.set(N / 2 + b.sprite.x * k, N / 2 + b.sprite.y * k)
      s.rotation = b.sprite.rotation
      s.scale.set(b.def.mmPerPx * k)
      this.bakeRoot.addChild(s)
      b.sprite.removeFromParent()
    }
    renderer.render({ container: this.bakeRoot, target: this.bakeRT, clear: false })
    for (const c of this.bakeRoot.removeChildren()) c.destroy()
    this.bakeRT.source.updateMipmaps()
    this.bakeQueue.length = 0
  }

  private dropLumpCollider(bug: Bug): void {
    if (!bug.collider) return
    this.byCollider.delete(bug.collider.handle)
    this.ballHandles.delete(bug.collider.handle)
    this.world.removeCollider(bug.collider, true)
    bug.collider = null
  }

  private knockThreshold(): number {
    return T.knockForce * this.ball.body.mass() * T.gravity * this.ball.r
  }

  /** A hard hit sends the newest poking-out insects flying. */
  private knock(force: number): void {
    if (this.time - this.lastKnock < T.knockCooldown) return
    const weight = this.ball.body.mass() * T.gravity * this.ball.r
    if (force < T.knockForce * weight) return
    this.lastKnock = this.time
    const count = clamp(Math.floor(force / (T.knockForce * weight)), 1, 3)
    const lumps = this.stuck.filter((b) => b.collider)
    for (let k = 0; k < count && lumps.length; k++) this.shed(lumps.pop()!)
    this.onBallResized()
  }

  /** A stuck insect lets go and flies off (call onBallResized after). */
  private shed(bug: Bug): void {
    const pose = this.worldPose(bug)
    this.dropLumpCollider(bug)
    this.stuck.splice(this.stuck.indexOf(bug), 1)
    this.ball.area = Math.max(Math.PI * T.startRadius ** 2, this.ball.area - T.growth * bug.info.area)
    bug.sprite.removeFromParent()
    bug.sprite.visible = true
    bug.sprite.position.set(pose.x, pose.y)
    bug.sprite.rotation = pose.angle
    this.flyLayer.addChild(bug.sprite)
    bug.mode = 'fly'
    bug.fly = this.newFlyState(pose.x, pose.y, this.gen.zones[bug.zone]!.radius)
    bug.regrabAt = this.time + 1.5
    this.startFlee(bug, 1.3)
  }

  private worldPose(bug: Bug): { x: number; y: number; angle: number } {
    if (bug.mode === 'stuck') {
      const p = this.ball.body.translation(), a = this.ball.body.rotation()
      const c = Math.cos(a), s = Math.sin(a)
      return { x: p.x + bug.sprite.x * c - bug.sprite.y * s, y: p.y + bug.sprite.x * s + bug.sprite.y * c, angle: a + bug.sprite.rotation }
    }
    return { x: bug.sprite.x, y: bug.sprite.y, angle: bug.sprite.rotation }
  }

  // ─── flyers ───────────────────────────────────────────────────────────────

  private startOrbit(bug: Bug): void {
    const f = bug.fly!
    const bp = this.ball.body.translation()
    f.mode = 'orbit'
    f.far = !this.canLift(bug)
    f.theta = Math.atan2(bug.sprite.y - bp.y, bug.sprite.x - bp.x)
    f.orbitR = Math.hypot(bug.sprite.x - bp.x, bug.sprite.y - bp.y)
    f.dir = this.rand() < 0.5 ? -1 : 1
    f.speed = range(this.rand, 1.2, 2.4)
    const [lo, hi] = f.far ? T.bigFlyers.seconds : T.orbitSeconds
    f.until = this.time + range(this.rand, lo, hi)
  }

  /** Away from the ball and upwards (flyers don't collide with the ground). */
  private startFlee(bug: Bug, boost: number): void {
    const f = bug.fly!
    const bp = this.ball.body.translation()
    const dx = bug.sprite.x - bp.x, dy = bug.sprite.y - bp.y
    const out = norm(dx, -Math.abs(dy) - 0.5 * Math.hypot(dx, dy))
    // Some fly the whole way, others only part of it.
    const short = this.rand() < T.fleeShort.share ? T.fleeShort.scale : 1
    const speed = range(this.rand, T.fleeSpeed[0], T.fleeSpeed[1]) * this.ball.r * boost * short
    f.mode = 'flee'
    f.vx = out.x * speed; f.vy = out.y * speed
    f.until = this.time + range(this.rand, 1.5, 3)
  }

  private updateFlyers(dt: number): void {
    const bp = this.ball.body.translation()
    const r = this.ball.r
    const light = T.lightRadius * r
    const flood = this.time < this.floodUntil
    const halfW = (window.innerWidth / 2 / this.viewScale) * 1.3, halfH = (window.innerHeight / 2 / this.viewScale) * 1.3
    const toAttach: Bug[] = []
    for (const bug of this.bugs) {
      const f = bug.fly
      if (!f || bug.mode !== 'fly') continue
      // Off-screen idlers only keep time; their loop is recomputed when they come into view.
      if (f.mode === 'idle' && (Math.abs(f.hx - this.camX) > halfW + 2 * f.wander || Math.abs(f.hy - this.camY) > halfH + f.wander)) {
        f.t += dt
        continue
      }
      const L = bug.info.length
      const sx = bug.sprite.x, sy = bug.sprite.y
      const dist = Math.hypot(sx - bp.x, sy - bp.y)
      f.t += dt
      let tx = sx, ty = sy, rate = 1.5
      if (f.mode === 'idle') {
        // Lazy loops around home.
        tx = f.hx + f.wander * (Math.sin(f.t * 0.31 + f.phase) + 0.35 * Math.sin(f.t * 0.97 + f.phase * 3))
        ty = f.hy + f.wander * 0.45 * Math.sin(f.t * 0.53 + f.phase * 2)
        // Insects too big to stick only notice a small ball now and then.
        const keen = this.canLift(bug) || this.rand() < T.bigFlyers.notice * dt
        if (!flood && dist < light * T.flyerNotice && this.time >= bug.regrabAt && keen) this.startOrbit(bug)
      } else if (f.mode === 'orbit') {
        f.theta += f.dir * f.speed * dt
        // Dorsal light response: they circle and bob, sometimes dipping into reach.
        // (Ones too big to stick keep a wary distance.)
        const want = r * (1.0 + 1.7 * (0.5 + 0.5 * Math.sin(f.t * 0.8 + f.phase))) + (f.far ? 0.6 * L + 1.5 * r : 0)
        f.orbitR += (want - f.orbitR) * Math.min(1, 1.5 * dt)
        tx = bp.x + Math.cos(f.theta) * f.orbitR
        ty = bp.y + Math.sin(f.theta) * f.orbitR
        rate = 5
        if (dist > light * T.flyerGiveUp || this.time > f.until) {
          f.mode = 'idle'; f.hx = sx; f.hy = sy - 2 * r; f.t = 0
          // Wander off for a while before the light pulls again (a long while, if too big to stick).
          bug.regrabAt = this.time + (f.far ? range(this.rand, T.bigFlyers.rest[0], T.bigFlyers.rest[1]) : 3)
        }
      } else {
        f.vx *= Math.exp(-0.6 * dt); f.vy *= Math.exp(-0.6 * dt)
        tx = sx + f.vx * dt; ty = sy + f.vy * dt
        rate = 60
        if (this.time > f.until) { f.mode = 'idle'; f.hx = tx; f.hy = ty; f.t = 0 }
      }
      const k = Math.min(1, rate * dt)
      const nx = sx + (tx - sx) * k, ny = sy + (ty - sy) * k
      if (Math.hypot(nx - sx, ny - sy) > 1e-6) {
        bug.sprite.rotation = lerpAngle(bug.sprite.rotation, Math.atan2(ny - sy, nx - sx) - bug.info.axis, Math.min(1, 5 * dt))
      }
      bug.sprite.position.set(nx, ny)
      bug.sprite.scale.set(bug.def.mmPerPx * (1 + 0.07 * Math.sin(f.t * 34 + f.phase)))

      if (Math.hypot(nx - bp.x, ny - bp.y) < this.catchRadius(L)) {
        if (this.canLift(bug)) toAttach.push(bug)
        else if (f.mode === 'orbit') { f.orbitR = r + L; f.dir = -f.dir }
      }
    }
    for (const bug of toAttach) this.attach(bug)
  }

  // ─── flood light ─────────────────────────────────────────────────────────

  /**
   * Flood light: see everything for a moment, zoomed out, then it recharges.
   * Insects nearby and on the ball's surface scatter, and everything touching
   * the ball takes off, which frees a ball wedged on an insect too big to lift.
   */
  flood(): void {
    if (this.paused || this.over || this.time < this.floodReadyAt) return
    this.floodUntil = this.time + T.floodSeconds
    this.floodReadyAt = this.floodUntil + T.floodRecharge
    const bp = this.ball.body.translation()
    const light = T.lightRadius * this.ball.r
    const view = this.viewRadius()
    const startled: Bug[] = []
    for (const bug of this.bugs) {
      const d = Math.hypot(bug.sprite.x - bp.x, bug.sprite.y - bp.y)
      if (bug.mode === 'fly' && d < view) this.startFlee(bug, 1)
      else if (bug.mode !== 'rest' && bug.mode !== 'perch') continue
      else if (d < this.catchRadius(bug.info.length) + 0.3 * this.ball.r) startled.push(bug) // touching: even the big ones go
      else if (!bug.obstacle && d < T.floodScatterRange * light && this.rand() < T.floodScatterChance) startled.push(bug)
    }
    for (const bug of startled) this.takeOff(bug, 'flee')
    // A little hop, to shake loose; and a check that it worked.
    this.popBall()
    this.unstick = { at: this.time + 1, x: bp.x, y: bp.y }

    // Whatever juts out from the ball takes fright too: an awkward ball comes out smoother (and smaller).
    const r = this.ball.r
    const jutting = this.stuck.filter((b) => !b.baked && this.poke(b) > T.floodShed.poke * r).sort((a, b) => this.poke(b) - this.poke(a))
    for (const bug of jutting.slice(0, T.floodShed.max)) this.shed(bug)
    this.onBallResized()
  }

  private popBall(): void {
    const body = this.ball.body
    body.applyImpulse({ x: 0, y: -body.mass() * Math.sqrt(2 * T.gravity * this.ball.r * T.floodPop * this.ball.r) }, true)
  }

  /**
   * A second after a flash: if the ball still hasn't got anywhere, whatever
   * insect it's pressed against is zapped (gone from the night) so play goes on.
   */
  private checkUnstuck(): void {
    const from = this.unstick!
    this.unstick = null
    const p = this.ball.body.translation(), r = this.ball.r
    if (Math.hypot(p.x - from.x, p.y - from.y) > 0.5 * r) return
    const pinning = new Set<Bug>()
    for (const c of this.ballColliders()) {
      this.world.contactPairsWith(c, (other) => {
        const bug = this.byCollider.get(other.handle)
        if (bug && bug.mode === 'rest') pinning.add(bug)
      })
    }
    for (const bug of pinning) this.zap(bug)
    if (pinning.size) { this.popBall(); this.hud.pickup(`Zapped ${pinning.size === 1 ? 'an insect' : `${pinning.size} insects`} to get free`) }
  }

  private zap(bug: Bug): void {
    if (bug.collider) {
      this.byCollider.delete(bug.collider.handle)
      this.ledges.removeInsect(bug.collider.handle)
      this.world.removeCollider(bug.collider, true)
      bug.collider = null
    }
    bug.mode = 'gone'
    bug.sprite.removeFromParent()
  }

  // ─── camera, light, HUD ──────────────────────────────────────────────────

  /** Zoom that shows the ball at its resting on-screen size. */
  private baseScale(): number {
    return (window.innerHeight * T.cameraRadiusFrac) / this.ball.r
  }

  /** Half the screen diagonal in world units. */
  private viewRadius(): number {
    return Math.hypot(window.innerWidth, window.innerHeight) / 2 / this.viewScale
  }

  /** How close a flying or perched insect's centre must come to stick. */
  private catchRadius(L: number): number {
    return T.catchReach * this.ball.r + T.catchLength * L
  }

  /** A lip just overhead that needs a bigger ball (or that the ball can now reach): for the HUD. */
  private lipAhead(): { label: string; needMm: number; ok: boolean } | null {
    const p = this.ball.body.translation(), r = this.ball.r
    let best: { label: string; needMm: number; ok: boolean } | null = null, bestD = Infinity
    for (const lip of this.gen.lips) {
      if (!lip.needR) continue
      const up = p.y - lip.y, dx = Math.abs(lip.x - p.x)
      if (up < 0 || up > 5 * r || dx > 12 * r) continue
      const d = dx + 2 * up
      if (d < bestD) {
        bestD = d
        const need = T.paths.lipEase * lip.needR // a smaller, lumpy ball might still make it
        best = { label: lip.kind === 'connector' ? 'Way up to a new area' : 'Path above', needMm: 2 * need, ok: r >= need }
      }
    }
    return best
  }

  private render(dt: number): void {
    const p = this.ball.body.translation()
    const v = this.ball.body.linvel()
    const r = this.ball.r
    this.ballSprite.position.set(p.x, p.y)
    this.ballSprite.rotation = this.ball.body.rotation()
    this.flushBake()

    // Katamari-style zoom: hold the zoom while the ball visibly grows, then pull out in one move.
    const restPx = window.innerHeight * T.cameraRadiusFrac
    const onScreen = r * this.zoomTarget
    if (onScreen > restPx * T.zoomOutAt || onScreen < restPx * 0.6) this.zoomTarget = this.baseScale()
    this.camScale += (this.zoomTarget - this.camScale) * (1 - Math.exp(-2.2 * dt))
    // The flood light pulls the camera out for a look at the wider playfield.
    const floodOn = this.time < this.floodUntil - 0.35
    this.floodZoomK += ((floodOn ? 1 : 0) - this.floodZoomK) * (1 - Math.exp(-(floodOn ? 4 : 5) * dt))
    this.viewScale = this.camScale * (1 - (1 - T.floodZoom) * this.floodZoomK)
    const k = 1 - Math.exp(-3 * dt)
    this.camX += (p.x + clamp(v.x * 0.35, -6 * r, 6 * r) - this.camX) * k
    this.camY += (p.y - 1.2 * r - this.camY) * k
    const W = window.innerWidth, H = window.innerHeight
    const s = this.viewScale
    this.worldLayer.scale.set(s)
    this.worldLayer.position.set(W / 2 - this.camX * s, H / 2 - this.camY * s)

    // Night → dawn.
    const progress = clamp(this.time / this.nightSeconds, 0, 1)
    const dawn = clamp((progress - 0.75) / 0.25, 0, 1)
    const flood = this.time < this.floodUntil
    const floodK = flood ? Math.min(1, (this.floodUntil - this.time) / 0.4, (this.time - (this.floodUntil - T.floodSeconds)) / 0.15) : 0
    const dark = (0.94 - 0.6 * dawn) * (1 - floodK)
    const sx = W / 2 + (p.x - this.camX) * s
    const sy = H / 2 + (p.y - this.camY) * s
    this.darkness.draw(sx, sy, T.lightRadius * r * s, dark, 1 - 0.7 * dawn, this.time)
    setSky(dawn)

    const gate = this.lipAhead()
    this.hud.update({
      diameterMm: 2 * r,
      collected: this.stuck.length,
      kinds: this.kindsSeen.size,
      sunriseIn: Math.max(0, this.nightSeconds - this.time),
      clock: clockText(this.nightStart + progress * (this.nightEnd - this.nightStart)),
      dawn: progress,
      floodReady: clamp(1 - (this.floodReadyAt - this.time) / (T.floodSeconds + T.floodRecharge), 0, 1),
      floodWait: Math.max(0, this.floodReadyAt - this.time),
      floodActive: flood,
      gate,
      paused: this.paused,
    })

    if (this.debugLayer) this.drawDebug()
  }

  private drawDebug(): void {
    const g = this.debugLayer!
    g.clear()
    const w = this.ball.r * 0.05
    const view = this.viewRadius()
    const bp = this.ball.body.translation()
    this.world.forEachCollider((c) => {
      const t = c.translation()
      const shape = c.shape
      const rot = c.rotation()
      const v0 = shape.type === RAPIER.ShapeType.ConvexPolygon ? (shape as RAPIER.ConvexPolygon).vertices : null
      const cx = t.x + (v0 ? v0[0]! : 0), cy = t.y + (v0 ? v0[1]! : 0)
      if (Math.hypot(cx - bp.x, cy - bp.y) > view * 2) return
      if (shape.type === RAPIER.ShapeType.Ball) {
        g.circle(t.x, t.y, (shape as RAPIER.Ball).radius).stroke({ width: w, color: 0x00ffaa })
      } else if (shape.type === RAPIER.ShapeType.ConvexPolygon) {
        const v = (shape as RAPIER.ConvexPolygon).vertices
        const out: number[] = []
        for (let i = 0; i < v.length; i += 2) {
          out.push(t.x + v[i]! * Math.cos(rot) - v[i + 1]! * Math.sin(rot), t.y + v[i]! * Math.sin(rot) + v[i + 1]! * Math.cos(rot))
        }
        const color = this.ballHandles.has(c.handle) ? 0xffaa00
          : this.ledges.isLedge(c.handle) ? (this.ledges.isActive(c.handle) ? 0x66ff66 : 0x2f6f3f) : 0xff3366
        g.poly(out).stroke({ width: w, color })
      }
    })
  }

  private track(part: keyof Game['perf'], ms: number): void {
    this.perf[part] += (ms - this.perf[part]) * 0.05
  }

  /** Numbers for scripts/playtest.ts. */
  debugState(): Record<string, number | boolean | string> {
    const p = this.ball.body.translation()
    let flying = 0, orbiting = 0
    for (const b of this.bugs) if (b.mode === 'fly') { flying++; if (b.fly?.mode === 'orbit') orbiting++ }
    const on = this.ledges.supporting(this.ball)
    const pokes = this.stuck.filter((b) => !b.baked).map((b) => this.poke(b) / this.ball.r)
    return {
      x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, r: Math.round(this.ball.r * 100) / 100,
      stuck: this.stuck.length, lumps: this.stuck.filter((b) => b.collider).length, zone: this.zoneNow,
      on: on >= 0 ? this.gen.paths[this.gen.ledges[on]!.path]!.kind : this.ctrl.grounded ? 'floor' : 'air',
      time: Math.round(this.time * 10) / 10, grounded: this.ctrl.grounded,
      fps: Math.round(this.app.ticker.FPS), flying, orbiting, floodIn: Math.round(Math.max(0, this.floodReadyAt - this.time)),
      jut: Math.round(Math.max(0, ...pokes) * 100) / 100, spines: pokes.filter((q) => q > 0.4).length,
      baked: this.stuck.filter((b) => b.baked).length,
      ms: Object.entries(this.perf).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' '),
    }
  }

  /** The ball as a picture, for the dawn screen. */
  snapshotBall(size = 320): HTMLCanvasElement | null {
    try {
      const b = this.ballSprite.getLocalBounds()
      const resolution = size / Math.max(b.width, b.height, 1e-6)
      return this.app.renderer.extract.canvas({ target: this.ballSprite, resolution }) as HTMLCanvasElement
    } catch {
      return null
    }
  }

  private endNight(): void {
    this.over = true
    const counts = new Map<string, number>()
    for (const b of this.stuck) counts.set(b.def.label, (counts.get(b.def.label) ?? 0) + 1)
    const kinds = [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
    let biggest: Bug | null = null
    for (const b of this.stuck) if (!biggest || b.info.length > biggest.info.length) biggest = b
    for (const b of this.stuck) b.sprite.visible = true
    this.onDawn({ diameterMm: 2 * this.ball.r, collected: [...this.stuck], total: this.bugs.length, kinds, biggest })
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function minMax(values: number[]): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v }
  return [lo, hi]
}

/** First index whose home x is ≥ x. */
function lowerBound(arr: Array<{ x: number }>, x: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]!.x < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function norm(x: number, y: number): { x: number; y: number } {
  const d = Math.hypot(x, y) || 1
  return { x: x / d, y: y / d }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

function clockText(minutesAfterNoon: number): string {
  const m = Math.floor(((minutesAfterNoon + 720) % 1440 + 1440) % 1440)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

const ZONE_COLORS = [0x6f5bd6, 0x5b7fd6, 0x4fa3b8, 0x5fb37d, 0xb3a24f, 0xc77a5a, 0xc75a8c]
function zoneColor(i: number): number {
  return ZONE_COLORS[i % ZONE_COLORS.length]!
}

let coreTex: Texture | null = null
/** The lamp: a bright violet-white disc with a soft edge (drawn under the insects). */
function coreTexture(): Texture {
  if (coreTex) return coreTex
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  g.addColorStop(0, 'rgba(250,245,255,1)')
  g.addColorStop(0.35, 'rgba(205,180,255,1)')
  g.addColorStop(0.82, 'rgba(140,95,255,0.95)')
  g.addColorStop(0.87, 'rgba(120,80,240,0.45)')
  g.addColorStop(1, 'rgba(100,60,220,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  coreTex = Texture.from(c)
  return coreTex
}

let glowTex: Texture | null = null
/** The lamp glowing through the insects packed over it (drawn additively on top of them). */
function glowTexture(): Texture {
  if (glowTex) return glowTex
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  g.addColorStop(0, 'rgba(200,175,255,0.62)')
  g.addColorStop(0.3, 'rgba(160,120,255,0.34)')
  g.addColorStop(0.7, 'rgba(120,80,240,0.12)')
  g.addColorStop(1, 'rgba(100,60,220,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  glowTex = Texture.from(c)
  return glowTex
}

/**
 * A path or area as a thick branch: bark under the walkable top edge (tapering
 * at the ends and at any gap), a lighter upper side, hanging moss, and a rim of
 * light in its zone's colour along the top, like the ground's.
 */
function drawPath(g: Graphics, p: Path, R: number): void {
  // Each stretch between gaps is drawn as its own branch.
  const pieces: number[][] = [[]]
  for (let k = 0; k < p.points.length; k += 2) {
    const x = p.points[k]!
    if (k > 0 && p.gaps?.some(([a, b]) => (p.points[k - 2]! + x) / 2 > a && (p.points[k - 2]! + x) / 2 < b)) pieces.push([])
    pieces[pieces.length - 1]!.push(x, p.points[k + 1]!)
  }
  for (const pts of pieces) drawBranch(g, pts, p.kind, p.zone, R)
}

function drawBranch(g: Graphics, pts: number[], kind: Path['kind'], zone: number, R: number): void {
  const n = pts.length / 2
  if (n < 2) return
  const thick = (kind === 'area' ? 0.95 : kind === 'connector' ? 0.6 : 0.5) * R
  const x0 = pts[0]!, x1 = pts[pts.length - 2]!
  const taper = (x: number) => Math.min(1, 0.3 + Math.min(x - x0, x1 - x) / (5 * R))
  const body = (depth: number) => {
    const out: number[] = []
    for (let k = 0; k < pts.length; k += 2) out.push(pts[k]!, pts[k + 1]!)
    for (let k = pts.length - 2; k >= 0; k -= 2) out.push(pts[k]!, pts[k + 1]! + depth * taper(pts[k]!))
    return out
  }
  g.poly(body(thick)).fill({ color: 0x231b26, alpha: 0.98 })
  g.poly(body(0.35 * thick)).fill({ color: 0x3a2d3c, alpha: 0.9 })
  // Moss hanging underneath now and then.
  let next = x0 + 2 * R
  for (let k = 0; k < pts.length; k += 2) {
    const x = pts[k]!
    if (x < next) continue
    const h1 = Math.abs((x * 7.13) % 1), h2 = Math.abs((x * 3.7) % 1) // stable pseudo-random
    next = x + (2 + 3 * h1) * R
    const y = pts[k + 1]! + thick * taper(x)
    g.moveTo(x, y)
    g.lineTo(x + 0.15 * R, y + (0.4 + 0.8 * h2) * R)
  }
  g.stroke({ width: 0.08 * R, color: 0x2c4a44, alpha: 0.7, cap: 'round' })
  g.poly(pts, false).stroke({ width: 0.14 * R, color: zoneColor(zone), alpha: 0.85, join: 'round', cap: 'round' })
}

let lastSky = -1
function setSky(dawn: number): void {
  const q = Math.round(dawn * 50) / 50
  if (q === lastSky) return
  lastSky = q
  const sky = document.getElementById('sky')
  if (!sky) return
  const mix = (a: number[], b: number[]) => `rgb(${a.map((v, i) => Math.round(v + (b[i]! - v) * q)).join(',')})`
  sky.style.background = `linear-gradient(to bottom, ${mix([6, 7, 20], [42, 52, 104])} 0%, ${mix([12, 12, 32], [160, 110, 140])} 60%, ${mix([18, 14, 36], [242, 160, 120])} 100%)`
}
