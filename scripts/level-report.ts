#!/usr/bin/env bun
/**
 * Prints how a level pack turns into zones: sizes, where each area is, its
 * paths, gates and insect counts. Handy when tuning src/tuning.ts.
 *
 *   bun scripts/level-report.ts public/levels/<pack>.mothball.zip [seed]
 */
import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { generateLevel } from '../src/levelgen'
import type { LevelPack } from '../src/pack'

const [zipPath, seedArg] = process.argv.slice(2)
if (!zipPath) { console.error('usage: bun scripts/level-report.ts <pack.zip> [seed]'); process.exit(1) }
const files = unzipSync(new Uint8Array(readFileSync(zipPath)))
const level = JSON.parse(strFromU8(files['level.json']!)) as LevelPack
const t0 = performance.now()
const gen = generateLevel(level.bugs, Number(seedArg ?? 1))
const cm = (mm: number) => `${(mm / 10).toFixed(1)}cm`
console.log(`${level.title}: ${level.bugs.length} insects → ${gen.zones.length} zones, ${gen.paths.length} paths, ${gen.ledges.length} one-way segments in ${(performance.now() - t0).toFixed(0)} ms`)
for (const z of gen.zones) {
  const here = gen.placements.filter((p) => p.zone === z.index)
  const rest = here.filter((p) => p.mode === 'rest'), fly = here.filter((p) => p.mode === 'fly')
  const perch = here.filter((p) => p.mode === 'perch'), obstacles = rest.filter((p) => p.obstacle)
  const branches = gen.paths.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'branch' && p.zone === z.index)
  const upThere = here.filter((p) => p.path != null && gen.paths[p.path]!.kind === 'branch').length
  const conn = gen.lips.find((l) => l.kind === 'connector' && l.zone === z.index)
  console.log(
    `zone ${z.index}: R=${z.radius.toFixed(1)}mm  area x ${cm(z.x0)}…${cm(z.x1)} (${((z.x1 - z.x0) / z.radius).toFixed(0)} R) at height ${cm(-z.baseY)}` +
    (conn ? `  reached by a lip ${(gen.zones[z.index - 1]!.baseY - conn.y).toFixed(1)}mm up at x ${cm(conn.x)} (needs r ≥ ${z.needR.toFixed(1)}mm)` : '  (the floor; start)') +
    `\n    ground=${rest.length} (obstacles ${obstacles.length}) perched=${perch.length} flyers=${fly.length}` +
    `  paths=${branches.length} [${branches.map(({ p }) => (p.needR ? `r≥${(p.needR / z.radius).toFixed(2)}R` : 'open') + (p.gaps ? ' +gap' : '')).join(', ')}] with ${upThere} insects up there` +
    `  gaps in the area: ${z.path >= 0 ? (gen.paths[z.path]!.gaps?.length ?? 0) : 0}`,
  )
}
