/** On-screen readouts (plain DOM over the canvas). */

export type HudState = {
  diameterMm: number
  collected: number
  kinds: number
  /** Real seconds left until sunrise. */
  sunriseIn: number
  /** Wall-clock time of night, from the insects' capture times. */
  clock: string
  dawn: number
  /** 0 … 1: how far the flood light has recharged. */
  floodReady: number
  /** Seconds until it's ready. */
  floodWait: number
  floodActive: boolean
  /** A lip overhead that asks for a size. */
  gate: { label: string; needMm: number; ok: boolean } | null
  paused: boolean
}

export class Hud {
  private size: HTMLElement
  private count: HTMLElement
  private clock: HTMLElement
  private sub: HTMLElement
  private dawn: HTMLElement
  private flood: HTMLElement
  private gate: HTMLElement
  private feed: HTMLElement
  private paused: HTMLElement
  private lastKey = ''

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-left"><div class="hud-size"></div><div class="hud-count"></div></div>
      <div class="hud-center"><div class="hud-clock"></div><div class="hud-sub"></div><div class="hud-dawn"><i></i></div></div>
      <div class="hud-right"><div class="hud-flood"></div><div class="hud-gate"></div></div>
      <div class="hud-feed"></div>
      <div class="hud-hint">← → roll · ↑ / Space hop · ↓↓ drop through a path · F / Ctrl flood light · P pause · R restart</div>
      <div class="hud-paused" hidden>Paused — press P</div>`
    const q = (s: string) => root.querySelector(s) as HTMLElement
    this.size = q('.hud-size'); this.count = q('.hud-count'); this.clock = q('.hud-clock'); this.sub = q('.hud-sub')
    this.dawn = q('.hud-dawn i'); this.flood = q('.hud-flood'); this.gate = q('.hud-gate')
    this.feed = q('.hud-feed'); this.paused = q('.hud-paused')
  }

  show(visible: boolean): void {
    this.root.hidden = !visible
  }

  update(s: HudState): void {
    const key = JSON.stringify(s)
    if (key === this.lastKey) return
    this.lastKey = key
    this.size.textContent = `⌀ ${formatMm(s.diameterMm)}`
    this.count.textContent = `${s.collected.toLocaleString()} insects · ${s.kinds} kinds`
    const left = Math.ceil(s.sunriseIn)
    this.clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
    this.clock.classList.toggle('late', left <= 30)
    this.sub.textContent = `until sunrise · ${s.clock}`
    this.dawn.style.width = `${(s.dawn * 100).toFixed(1)}%`
    this.flood.textContent = s.floodActive ? 'Flood light' : s.floodReady >= 1 ? 'Flood light ready (F)' : `Flood light · ${Math.ceil(s.floodWait)} s`
    this.flood.classList.toggle('ready', !s.floodActive && s.floodReady >= 1)
    this.flood.classList.toggle('active', s.floodActive)
    if (s.gate) {
      this.gate.hidden = false
      this.gate.textContent = s.gate.ok ? `${s.gate.label}: hop up ✓` : `${s.gate.label}: needs ⌀ ${formatMm(s.gate.needMm)}`
      this.gate.classList.toggle('ok', s.gate.ok)
    } else {
      this.gate.hidden = true
    }
    this.paused.hidden = !s.paused
  }

  /** A pickup line that fades out. */
  pickup(text: string): void {
    const line = document.createElement('div')
    line.textContent = text
    this.feed.prepend(line)
    while (this.feed.children.length > 6) this.feed.lastElementChild?.remove()
    setTimeout(() => line.classList.add('fade'), 1600)
    setTimeout(() => line.remove(), 2600)
  }

  clearFeed(): void {
    this.feed.innerHTML = ''
  }
}

export function formatMm(mm: number): string {
  if (mm >= 1000) return `${(mm / 1000).toFixed(2)} m`
  if (mm >= 100) return `${(mm / 10).toFixed(1)} cm`
  if (mm >= 10) return `${mm.toFixed(0)} mm`
  return `${mm.toFixed(1)} mm`
}
