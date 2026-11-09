/**
 * The night: a 2D canvas over the WebGL stage, black except for a soft hole
 * of light around the ball. The flood light lifts it for a moment; dawn
 * thins it out.
 */
export class Darkness {
  private ctx: CanvasRenderingContext2D
  private dpr = 1

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    this.resize()
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(window.innerWidth * this.dpr)
    this.canvas.height = Math.round(window.innerHeight * this.dpr)
  }

  /**
   * @param x ball centre, CSS px
   * @param radius light radius, CSS px
   * @param darkness 0 (none) … 1 (pitch black outside the light)
   * @param glow 0 … 1, the UV halo's strength
   */
  draw(x: number, y: number, radius: number, darkness: number, glow: number, time: number): void {
    const { ctx, dpr } = this
    const W = this.canvas.width, H = this.canvas.height
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (darkness > 0.001) {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = `rgba(2, 3, 10, ${darkness})`
      ctx.fillRect(0, 0, W, H)
      // Cut the light out of the dark.
      const flicker = 1 + 0.015 * Math.sin(time * 13) + 0.01 * Math.sin(time * 31)
      const R = radius * dpr * flicker
      const cx = x * dpr, cy = y * dpr
      const hole = ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
      hole.addColorStop(0, 'rgba(0,0,0,1)')
      hole.addColorStop(0.45, 'rgba(0,0,0,0.97)')
      hole.addColorStop(0.75, 'rgba(0,0,0,0.6)')
      hole.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = hole
      ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R)
    }
    if (glow > 0.001) {
      // UV wash: violet near the lamp, fading out.
      const cx = x * dpr, cy = y * dpr
      const R = radius * dpr * 0.9
      const uv = ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
      uv.addColorStop(0, `rgba(150, 110, 255, ${0.22 * glow})`)
      uv.addColorStop(0.5, `rgba(110, 70, 230, ${0.08 * glow})`)
      uv.addColorStop(1, 'rgba(90, 50, 200, 0)')
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = uv
      ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R)
    }
    ctx.globalCompositeOperation = 'source-over'
  }
}
