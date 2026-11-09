import { Application, CullerPlugin, extensions } from 'pixi.js'
import { initPhysics } from './physics'
import { loadPackFromBytes, loadPackFromUrl, type LoadedPack } from './pack'
import { Game, type NightResult } from './game'
import { Darkness } from './darkness'
import { Hud, formatMm } from './hud'
import { T } from './tuning'
import logoUrl from './assets/logo-ball.svg'

const DEFAULT_LEVEL = 'levels/bowedBarbo-demo.mothball.zip'

const screen = document.getElementById('screen')!
const params = new URLSearchParams(location.search)
const debug = params.has('debug')

let app: Application
let darkness: Darkness
let hud: Hud
let pack: LoadedPack | null = null
let packError = ''
let game: Game | null = null

async function boot(): Promise<void> {
  showMessage('Waking up…')
  extensions.add(CullerPlugin) // skip drawing insects that are off screen
  app = new Application()
  await app.init({ resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2) })
  document.getElementById('stage')!.appendChild(app.canvas)
  darkness = new Darkness(document.getElementById('darkness') as HTMLCanvasElement)
  window.addEventListener('resize', () => darkness.resize())
  hud = new Hud(document.getElementById('hud')!)
  await initPhysics()
  setupDrop()
  setupTouch()
  if (debug) {
    const fps = document.createElement('div')
    fps.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9;font:12px ui-monospace,monospace;color:#9f9;text-shadow:0 1px 3px #000'
    document.body.appendChild(fps)
    setInterval(() => { fps.textContent = `${Math.round(app.ticker.FPS)} fps` }, 500)
  }
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'r' && game && !e.repeat) start()
  })

  try {
    pack = await loadPackFromUrl(params.get('level') ?? DEFAULT_LEVEL, showMessage)
  } catch (err) {
    packError = (err as Error).message
  }
  showMenu()
}

function start(): void {
  if (!pack) return
  game?.destroy()
  darkness.draw(0, 0, 0, 0, 0, 0)
  screen.hidden = true
  // ?night=60 shortens the night (seconds), for testing.
  const night = Number(params.get('night')) || T.nightSeconds
  game = new Game(app, pack, darkness, hud, showDawn, debug, night)
  if (debug || params.has('test')) (window as unknown as { __game: Game }).__game = game
}

/** The Mothbox mark inside a ball, and the name in the Mothbox lettering (Big Shoulders Stencil). */
function logo(): string {
  return `<h1 class="logo"><img src="${logoUrl}" alt=""><span>Mothball</span></h1>`
}

function showMessage(text: string): void {
  screen.hidden = false
  screen.innerHTML = `<div class="panel">${logo()}<p class="tag">${escapeHtml(text)}</p></div>`
}

function showMenu(): void {
  game?.destroy()
  game = null
  darkness.draw(0, 0, 0, 0.6, 0, 0)
  const level = pack?.level
  const card = level
    ? `<div class="card">
        <div class="card-title">${escapeHtml(level.title)}</div>
        <div class="card-meta">${level.bugs.length.toLocaleString()} insects${level.source.nights.length ? ` · ${level.source.nights.length} night${level.source.nights.length === 1 ? '' : 's'}` : ''}${level.calibrated ? ' · real sizes' : ' · some sizes estimated'}</div>
      </div>`
    : `<div class="card error">${escapeHtml(packError || 'No level loaded.')}</div>`
  screen.hidden = false
  screen.innerHTML = `
    <div class="panel">
      ${logo()}
      <p class="tag">You are a UV light. Roll up a night of insects before dawn.</p>
      ${card}
      <div class="buttons">
        <button class="primary" id="play" ${pack ? '' : 'disabled'}>Play</button>
        <label class="secondary">Load a level pack…<input type="file" accept=".zip" hidden></label>
      </div>
      <p class="small">Or drop a <code>.mothball.zip</code> anywhere. Make one in Mothbot Classify → Create Mosaic → <b>Export game level</b>.</p>
      <ul class="rules">
        <li><b>← →</b> roll · <b>↑ / Space</b> hop (one at a time)</li>
        <li>Insects shorter than your radius stick to you. Bigger ones are obstacles, for now.</li>
        <li>Paths branch off overhead. Hop up onto one to explore; there are more insects up there. Tap <b>↓</b> twice to drop back through.</li>
        <li>Some lips are too high until you've grown, and they lead up to new areas. A lumpy enough ball can sometimes lever its way up early.</li>
        <li>Mind the gaps up high: hop them, or be big enough to roll across.</li>
        <li>Insects caught in flight stick out like spines, so your ball gets awkward.</li>
        <li><b>F</b> or <b>Ctrl</b>: flood light. See the wider playfield for ${T.floodSeconds} s, then it recharges (${T.floodRecharge} s). Nearby insects scatter, anything you're stuck against takes off, and whatever juts out of your ball is shaken off, so you roll smoother but smaller.</li>
        <li>Dawn ends the night.</li>
      </ul>
    </div>`
  screen.querySelector('#play')?.addEventListener('click', start)
  screen.querySelector('input[type=file]')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) void loadFile(file)
  })
}

function showDawn(result: NightResult): void {
  const snapshot = game?.snapshotBall(320) ?? null
  hud.show(false)
  const kinds = result.kinds.slice(0, 6).map((k) => `<li><span>${escapeHtml(k.label)}</span><b>${k.count}</b></li>`).join('')
  screen.hidden = false
  screen.innerHTML = `
    <div class="panel dawn">
      <h1>Dawn</h1>
      <div class="dawn-ball"></div>
      <p class="big">⌀ ${formatMm(result.diameterMm)}</p>
      <p class="tag">${result.collected.length.toLocaleString()} of ${result.total.toLocaleString()} insects · ${result.kinds.length} kinds</p>
      ${result.biggest ? `<div class="biggest"><div class="biggest-img"></div><div>Biggest catch<br><b>${escapeHtml(result.biggest.def.label)}</b> · ${formatMm(result.biggest.info.length)}</div></div>` : ''}
      ${kinds ? `<ol class="kinds">${kinds}</ol>` : ''}
      <div class="buttons">
        <button class="primary" id="again">Roll again</button>
        <button class="secondary" id="menu">Menu</button>
      </div>
    </div>`
  if (snapshot) screen.querySelector('.dawn-ball')!.appendChild(snapshot)
  if (result.biggest && pack) {
    const d = result.biggest.def
    const c = document.createElement('canvas')
    const s = 72 / Math.max(d.w, d.h)
    c.width = Math.round(d.w * s); c.height = Math.round(d.h * s)
    c.getContext('2d')!.drawImage(pack.atlases[d.atlas]!, d.x, d.y, d.w, d.h, 0, 0, c.width, c.height)
    screen.querySelector('.biggest-img')!.appendChild(c)
  }
  screen.querySelector('#again')!.addEventListener('click', start)
  screen.querySelector('#menu')!.addEventListener('click', showMenu)
}

async function loadFile(file: File): Promise<void> {
  try {
    pack = await loadPackFromBytes(new Uint8Array(await file.arrayBuffer()), showMessage)
    packError = ''
  } catch (err) {
    packError = (err as Error).message
  }
  showMenu()
}

function setupDrop(): void {
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping') })
  window.addEventListener('dragleave', () => document.body.classList.remove('dropping'))
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    document.body.classList.remove('dropping')
    const file = e.dataTransfer?.files?.[0]
    if (file) void loadFile(file)
  })
}

/** On-screen buttons for touch screens. */
function setupTouch(): void {
  if (!window.matchMedia('(pointer: coarse)').matches) return
  const pad = document.createElement('div')
  pad.id = 'touch'
  pad.innerHTML = '<button data-k="left">◀</button><button data-k="right">▶</button><button data-k="flood">☀</button><button data-k="down">▼</button><button data-k="hop">▲</button>'
  document.body.appendChild(pad)
  let dir = 0
  for (const btn of pad.querySelectorAll('button')) {
    const k = btn.dataset.k
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      if (k === 'left') dir = -1
      if (k === 'right') dir = 1
      if (k === 'flood') game?.flood()
      game?.setTouch(dir, k === 'hop', k === 'down')
    })
    btn.addEventListener('pointerup', () => {
      if ((k === 'left' && dir < 0) || (k === 'right' && dir > 0)) dir = 0
      game?.setTouch(dir, false)
    })
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

void boot()
