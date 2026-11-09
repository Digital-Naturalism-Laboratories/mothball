/**
 * Rapier setup and the ball's movement. Shared by the game and by
 * scripts/calibrate-climb.ts, so tuning measured there matches play.
 *
 * The ball rolls rather than slides: input sets a target *spin* and applies
 * torque, and friction turns spin into travel (no direct sideways force on the
 * ground). Hops are single: only from the ground, with a cooldown.
 */
import RAPIER from '@dimforge/rapier2d-compat'
import { T } from './tuning'

export { RAPIER }

let ready: Promise<void> | null = null
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init()
  return ready
}

export type Ball = {
  body: RAPIER.RigidBody
  core: RAPIER.Collider
  /** Core radius (mm). */
  r: number
  /** Core area (mm²); radius follows from it. */
  area: number
}

export function createWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: 0 })
  world.numSolverIterations = 6
  return world
}

export function createBall(world: RAPIER.World, x: number, y: number, r: number): Ball {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setCcdEnabled(true).setCanSleep(false),
  )
  const core = world.createCollider(
    RAPIER.ColliderDesc.ball(r).setDensity(T.density).setFriction(T.friction).setRestitution(0)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
    body,
  )
  return { body, core, r, area: Math.PI * r * r }
}

/** Scale world-wide values to the ball's size: gravity and tolerances. */
export function scaleWorldToBall(world: RAPIER.World, ball: Ball): void {
  world.gravity = { x: 0, y: T.gravity * ball.r }
  world.lengthUnit = Math.max(0.05, ball.r * 2)
}

export type ControlInput = { dir: number; hop: boolean }
export type ControlState = { hopCooldown: number; grounded: boolean; groundedFor: number }

export function newControlState(): ControlState {
  return { hopCooldown: 0, grounded: false, groundedFor: 0 }
}

/**
 * True when any of the ball's colliders presses on something below it.
 * `ballColliders` is the core plus any lumps (stuck insects with colliders).
 */
export function isGrounded(world: RAPIER.World, ballColliders: Iterable<RAPIER.Collider>): boolean {
  let grounded = false
  for (const c of ballColliders) {
    world.contactPairsWith(c, (other) => {
      if (grounded || other.parent()?.handle === c.parent()?.handle) return
      world.contactPair(c, other, (manifold, flipped) => {
        if (manifold.numContacts() === 0) return
        const n = manifold.normal() // from c towards other (unless flipped)
        const ny = flipped ? -n.y : n.y
        if (ny > 0.45) grounded = true // other is below (y down)
      })
    })
    if (grounded) break
  }
  return grounded
}

/** One fixed step of input → torque / hop. Call before world.step(). */
export function applyControl(world: RAPIER.World, ball: Ball, colliders: Iterable<RAPIER.Collider>, input: ControlInput, state: ControlState, dt: number): void {
  const { body, r } = ball
  state.grounded = isGrounded(world, colliders)
  state.groundedFor = state.grounded ? state.groundedFor + dt : 0
  state.hopCooldown = Math.max(0, state.hopCooldown - dt)

  const mass = body.mass()
  // Inertia about the contact point: what spinning up a rolling ball actually has to move.
  const rollingInertia = body.principalInertia() + mass * r * r
  const w = body.angvel()
  if (input.dir !== 0) {
    const target = input.dir * T.rollSpeed
    const dw = clamp(target - w, -T.rollAccel * dt, T.rollAccel * dt)
    body.applyTorqueImpulse(rollingInertia * dw, true)
  } else if (state.grounded) {
    const dw = clamp(-w, -T.brake * dt, T.brake * dt)
    body.applyTorqueImpulse(rollingInertia * dw, true)
  }
  if (!state.grounded && input.dir !== 0) {
    body.applyImpulse({ x: input.dir * T.airControl * r * mass * dt, y: 0 }, true)
  }
  if (input.hop && state.grounded && state.hopCooldown === 0) {
    const g = T.gravity * r
    const v = Math.sqrt(2 * g * T.hopHeight * r)
    const vy = body.linvel().y
    body.applyImpulse({ x: 0, y: -mass * (v + Math.max(0, vy)) }, true)
    state.hopCooldown = T.hopCooldown
    state.grounded = false
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
