#!/usr/bin/env bun
/**
 * Plays the game in headless Chrome: clicks Play, holds keys per a script,
 * prints the ball's state and saves screenshots. Needs `bun dev` running.
 *
 *   bun scripts/playtest.ts [out-dir] [url]           holds →, hops now and then
 *   BOT=route bun scripts/playtest.ts [out-dir] [url]  roams each area, then takes the way up once big enough
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const outDir = process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'mothball-playtest-'))
const url = process.argv[3] ?? 'http://localhost:5180/?test'
mkdirSync(outDir, { recursive: true })
const PORT = 9335
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'mothball-chrome-'))}`,
  '--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => chrome.kill('SIGKILL'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let wsUrl = ''
for (let i = 0; i < 50 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t: any) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
  if (!wsUrl) await sleep(200)
}
const ws = new WebSocket(wsUrl)
await new Promise((r) => (ws.onopen = r))
let id = 1
const pending = new Map<number, (v: any) => void>()
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', m.params.exceptionDetails?.exception?.description?.slice(0, 800))
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) console.log(`[console.${m.params.type}]`, m.params.args.map((a: any) => a.value ?? a.description).join(' ').slice(0, 400))
}
const send = (method: string, params: any = {}): Promise<any> => { const i = id++; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)) }
const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
const KEYS: Record<string, [string, number]> = { right: ['ArrowRight', 39], left: ['ArrowLeft', 37], hop: ['ArrowUp', 38], flood: ['f', 70] }
const key = (type: 'keyDown' | 'keyUp', k: string) => send('Input.dispatchKeyEvent', { type, key: KEYS[k]![0], code: KEYS[k]![0], windowsVirtualKeyCode: KEYS[k]![1] })
const shot = async (name: string) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, 'base64')) }
const state = async () => evaluate('window.__game?.debugState()')

await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url })
for (let i = 0; i < 60; i++) { if (await evaluate("!!document.querySelector('#play:not([disabled])')")) break; await sleep(500) }
await shot('0-menu.png')
await evaluate("document.querySelector('#play').click()")
await sleep(1500)
await shot('1-start.png')
console.log('start', await state())

if (process.env.BOT === 'route') {
  // Explore like a player who knows the way: roam the current area (hopping now and then, which
  // gets onto open paths), and once big enough head for the lip up to the next area and climb it.
  await evaluate(`(() => { const g = window.__game; let roam = 1, nextHop = 0, wasX = 0, stuckFor = 0, dropAt = 0
    window.__bot = setInterval(() => {
      const p = g.ball.body.translation(), r = g.ball.r, z = g.zoneNow, on = g.ledges.supporting(g.ball)
      const onPath = on >= 0 ? g.gen.ledges[on].path : -1
      const next = g.gen.zones[z + 1], lip = g.gen.lips.find((l) => l.kind === 'connector' && l.zone === z + 1)
      const area = g.gen.zones[z]
      let dir = roam, hop = false, down = false
      if (lip && onPath === lip.path) dir = Math.sign(next.arrive.x - lip.x) // up the ramp and on into the area
      else if (lip && r >= next.needR) {
        const dx = lip.x - p.x
        dir = Math.abs(dx) < 0.6 * r ? 0 : Math.sign(dx)
        if (onPath >= 0 && g.gen.paths[onPath].kind === 'branch') down = true
        else if (Math.abs(dx) < 1.5 * r && g.ctrl.grounded) hop = true
      } else {
        if (p.x > area.x1 - 9 * area.radius) roam = -1
        if (p.x < area.x0 + 9 * area.radius) roam = 1
        dir = roam
        const nearEnd = p.x > area.x1 - 14 * area.radius || p.x < area.x0 + 14 * area.radius
        if (g.time > nextHop && g.ctrl.grounded && !nearEnd) { hop = true; nextHop = g.time + 1.3 }
      }
      // Hop gaps in the path underfoot.
      if (onPath >= 0 && g.ctrl.grounded && dir) {
        for (const [a, b] of g.gen.paths[onPath].gaps ?? []) {
          const edge = dir > 0 ? a : b
          if ((edge - p.x) * dir > 0 && (edge - p.x) * dir < 1.6 * r) hop = true
        }
      }
      // Wedged? Turn round and hop.
      if (Math.abs(p.x - wasX) < 0.05 * r) stuckFor++; else stuckFor = 0
      wasX = p.x
      if (stuckFor > 40) { roam = -roam; hop = true; stuckFor = 0 }
      g.keys.delete('arrowleft'); g.keys.delete('arrowright')
      if (dir > 0) g.keys.add('arrowright'); if (dir < 0) g.keys.add('arrowleft')
      if (hop) g.hopQueuedAt = g.time
      if (down && g.time > dropAt) { g.dropQueuedAt = g.time; dropAt = g.time + 1 }
    }, 50) })()`)
  const t0 = Date.now()
  let n = 2
  while (Date.now() - t0 < Number(process.env.PLAY_MS ?? 40000)) {
    await sleep(1500)
    const s = await state()
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(s))
    if ((Date.now() - t0) % 12000 < 1600) await shot(`${n++}-route.png`)
    if (s?.over) break
  }
  await shot(`${n++}-end.png`)
  console.log('screenshots in', outDir)
  process.exit(0)
}

// Roll right, hopping now and then; report every few seconds.
await key('keyDown', 'right')
const t0 = Date.now()
let n = 2
while (Date.now() - t0 < Number(process.env.PLAY_MS ?? 40000)) {
  await sleep(1200)
  await key('keyDown', 'hop'); await sleep(60); await key('keyUp', 'hop')
  const s = await state()
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(s))
  if ((Date.now() - t0) % 10000 < 1300) await shot(`${n++}-play.png`)
}
await key('keyDown', 'flood'); await sleep(400); await shot(`${n++}-flood.png`); await key('keyUp', 'flood')
await key('keyUp', 'right')
console.log('screenshots in', outDir)
process.exit(0)
