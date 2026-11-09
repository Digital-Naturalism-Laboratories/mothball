#!/usr/bin/env bun
/**
 * Measures the tallest solid step a bare ball can climb, rolling only and
 * rolling + one hop, using the game's own physics and controls
 * (src/physics.ts). Handy when shaping solid terrain. Hopping up onto
 * one-way paths (the lips that gate the zones) is measured in
 * src/ledges.test.ts.
 *
 *   bun scripts/calibrate-climb.ts
 */
import { RAPIER, applyControl, createBall, createWorld, initPhysics, newControlState, scaleWorldToBall } from '../src/physics'

await initPhysics()
const DT = 1 / 60

function climbs(r: number, stepPerR: number, hop: boolean): boolean {
  const world = createWorld()
  const h = stepPerR * r
  const wallX = 12 * r
  const ground = new Float32Array([-50 * r, 0, wallX, 0, wallX, -h, wallX + 60 * r, -h])
  world.createCollider(RAPIER.ColliderDesc.polyline(ground).setFriction(1), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()))
  const ball = createBall(world, 0, -r, r)
  scaleWorldToBall(world, ball)
  const state = newControlState()
  for (let i = 0; i < 6 * 60; i++) {
    const p = ball.body.translation()
    const wantHop = hop && p.x > wallX - 1.6 * r && p.x < wallX
    applyControl(world, ball, [ball.core], { dir: 1, hop: wantHop }, state, DT)
    world.step()
    if (ball.body.translation().x > wallX + 2 * r && ball.body.translation().y < -h) { world.free(); return true }
  }
  world.free()
  return false
}

function maxStep(r: number, hop: boolean): number {
  let lo = 0, hi = 4
  for (let k = 0; k < 14; k++) {
    const mid = (lo + hi) / 2
    if (climbs(r, mid, hop)) lo = mid
    else hi = mid
  }
  return lo
}

for (const r of [1.5, 6, 24, 90]) {
  console.log(`r=${r}mm  roll only: ${maxStep(r, false).toFixed(2)} r   roll + hop: ${maxStep(r, true).toFixed(2)} r`)
}
