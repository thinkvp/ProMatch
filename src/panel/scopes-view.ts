/**
 * Draws the scopes strip: an overlaid vectorscope, overlaid luma histograms
 * and a readout table. Source is blue and the matched target amber (the role
 * colours used across the panel); where the two overlap the vectorscope goes
 * white, so "matched" reads as "one cloud". The target as shot can be added
 * in grey. What is drawn never depends on the image view (Before / Split /
 * After) — the key always says exactly what is shown. Data comes from
 * core/scopes.ts.
 */
import { type LumaStats, SKIN_LINE_DEG, type VectorDensity, barTargets } from '../core/scopes.ts'

const SRC: [number, number, number] = [74, 168, 255]
const TGT: [number, number, number] = [240, 166, 64]
const ORIG: [number, number, number] = [150, 150, 150]

export interface ScopeLayer {
  vector: VectorDensity
  luma: LumaStats
}

function css(v: [number, number, number], a = 1): string {
  return `rgba(${v[0]},${v[1]},${v[2]},${a})`
}

export class ScopesView {
  zoom = 2

  constructor(
    private vCanvas: HTMLCanvasElement,
    private lCanvas: HTMLCanvasElement,
    private readout: HTMLElement,
  ) {}

  /** Vectorscope grid size in device pixels for the current canvas size. */
  vectorSize(): number {
    const dpr = window.devicePixelRatio || 1
    return Math.max(64, Math.round(this.vCanvas.clientWidth * dpr))
  }

  private fit(c: HTMLCanvasElement): [number, number] {
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(c.clientWidth * dpr))
    const h = Math.max(1, Math.round(c.clientHeight * dpr))
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    return [w, h]
  }

  clear(message: string): void {
    for (const c of [this.vCanvas, this.lCanvas]) {
      const [w, h] = this.fit(c)
      c.getContext('2d')!.clearRect(0, 0, w, h)
    }
    this.readout.innerHTML = `<p class="scope-empty">${message}</p>`
  }

  /** `original` (the target as shot) is optional, drawn in grey behind the others. */
  render(source: ScopeLayer, matched: ScopeLayer, original: ScopeLayer | null): void {
    this.drawVector(source.vector, matched.vector, original?.vector ?? null)
    this.drawLuma(source.luma, matched.luma, original?.luma ?? null)
    this.drawReadout(source.luma, matched.luma, original?.luma ?? null)
  }

  private drawVector(a: VectorDensity, b: VectorDensity, o: VectorDensity | null): void {
    const [W, H] = this.fit(this.vCanvas)
    const ctx = this.vCanvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, W, H)
    const n = a.size
    const ox = Math.round((W - n) / 2)
    const oy = Math.round((H - n) / 2)

    // Original first, faint and opaque-blended, so it sits behind.
    if (o?.max) ctx.drawImage(this.layerImage(o, ORIG, 0.55), ox, oy)
    // Source and matched target added on top of each other: overlap turns white.
    ctx.globalCompositeOperation = 'lighter'
    for (const [d, col] of [
      [a, SRC],
      [b, TGT],
    ] as const) {
      if (d.max) ctx.drawImage(this.layerImage(d, col, 1), ox, oy)
    }
    ctx.globalCompositeOperation = 'source-over'
    this.drawGraticule(ctx, ox, oy, n, dpr)
  }

  private layerImage(d: VectorDensity, col: readonly [number, number, number], opacity: number): HTMLCanvasElement {
    const n = d.size
    const img = new ImageData(n, n)
    const lm = Math.log1p(d.max)
    for (let i = 0; i < d.counts.length; i++) {
      const c = d.counts[i]
      if (!c) continue
      const t = Math.pow(Math.log1p(c) / lm, 0.7)
      img.data[i * 4] = col[0]
      img.data[i * 4 + 1] = col[1]
      img.data[i * 4 + 2] = col[2]
      img.data[i * 4 + 3] = Math.round((60 + 195 * t) * opacity)
    }
    const off = document.createElement('canvas')
    off.width = n
    off.height = n
    off.getContext('2d')!.putImageData(img, 0, 0)
    return off
  }

  private drawGraticule(ctx: CanvasRenderingContext2D, ox: number, oy: number, n: number, dpr: number): void {
    // Graticule on top, faint.
    const cx = ox + n / 2
    const cy = oy + n / 2
    const k = (n / 2 - 2) * 2 * this.zoom
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = dpr
    ctx.beginPath()
    ctx.arc(cx, cy, n / 2 - 2, 0, Math.PI * 2)
    ctx.moveTo(cx - n / 2, cy)
    ctx.lineTo(cx + n / 2, cy)
    ctx.moveTo(cx, cy - n / 2)
    ctx.lineTo(cx, cy + n / 2)
    ctx.stroke()
    // Skin-tone line.
    const a0 = (SKIN_LINE_DEG * Math.PI) / 180
    ctx.strokeStyle = 'rgba(255,200,160,0.45)'
    ctx.setLineDash([4 * dpr, 3 * dpr])
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(a0) * (n / 2 - 2), cy - Math.sin(a0) * (n / 2 - 2))
    ctx.stroke()
    ctx.setLineDash([])
    // 75% bar targets, where they fit at this zoom.
    ctx.font = `${9 * dpr}px system-ui, sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    for (const t of barTargets()) {
      const x = cx + t.cb * k
      const y = cy - t.cr * k
      if (Math.hypot(x - cx, y - cy) > n / 2 - 6 * dpr) continue
      ctx.strokeRect(x - 3 * dpr, y - 3 * dpr, 6 * dpr, 6 * dpr)
      ctx.fillText(t.name, x + 5 * dpr, y + 3 * dpr)
    }
  }

  private drawLuma(a: LumaStats, b: LumaStats, o: LumaStats | null): void {
    const [W, H] = this.fit(this.lCanvas)
    const ctx = this.lCanvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, W, H)
    const padB = 14 * dpr
    const plotH = H - padB - 4 * dpr
    // Square root so small populations (deep shadows, highlights) stay visible.
    let max = 0
    for (let i = 0; i <= 100; i++) max = Math.max(max, Math.sqrt(a.hist[i]), Math.sqrt(b.hist[i]), o ? Math.sqrt(o.hist[i]) : 0)
    const X = (v: number) => (v / 100) * (W - 1)
    const Y = (f: number) => 4 * dpr + plotH * (1 - (max ? Math.sqrt(f) / max : 0))

    // Grid every 10 IRE.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = dpr
    ctx.beginPath()
    for (let v = 0; v <= 100; v += 10) {
      ctx.moveTo(X(v), 4 * dpr)
      ctx.lineTo(X(v), 4 * dpr + plotH)
    }
    ctx.stroke()

    if (o) {
      // Original as a dashed grey outline only, behind the two that matter.
      ctx.beginPath()
      for (let i = 0; i <= 100; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i), Y(o.hist[i]))
      ctx.setLineDash([4 * dpr, 3 * dpr])
      ctx.strokeStyle = css(ORIG, 0.8)
      ctx.lineWidth = 1.2 * dpr
      ctx.stroke()
      ctx.setLineDash([])
    }
    for (const [s, col] of [
      [a, SRC],
      [b, TGT],
    ] as const) {
      ctx.beginPath()
      ctx.moveTo(X(0), Y(0))
      for (let i = 0; i <= 100; i++) ctx.lineTo(X(i), Y(s.hist[i]))
      ctx.lineTo(X(100), Y(0))
      ctx.closePath()
      ctx.fillStyle = css(col, 0.28)
      ctx.fill()
      ctx.beginPath()
      for (let i = 0; i <= 100; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i), Y(s.hist[i]))
      ctx.strokeStyle = css(col, 0.9)
      ctx.lineWidth = 1.2 * dpr
      ctx.stroke()
    }

    // Percentile ticks: source above the axis, target below.
    const axis = 4 * dpr + plotH
    for (const [s, col, dir] of [
      [a, SRC, -1],
      [b, TGT, 1],
    ] as const) {
      ctx.strokeStyle = css(col)
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      for (const v of [s.p05, s.p50, s.p95]) {
        ctx.moveTo(X(v), axis)
        ctx.lineTo(X(v), axis + dir * 6 * dpr)
      }
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = `${9 * dpr}px system-ui, sans-serif`
    ctx.textBaseline = 'top'
    for (const v of [0, 50, 100]) {
      const t = String(v)
      const tw = ctx.measureText(t).width
      ctx.fillText(t, Math.min(W - tw, Math.max(0, X(v) - tw / 2)), axis + 5 * dpr)
    }
  }

  private drawReadout(a: LumaStats, b: LumaStats, o: LumaStats | null): void {
    type Pick = (l: LumaStats) => number
    const row = (label: string, pick: Pick, unit: string, tol: number, title: string) => {
      const s = pick(a)
      const t = pick(b)
      const off = Math.abs(t - s) > tol
      return (
        `<tr title="${title}"><th>${label}</th><td>${s.toFixed(0)}${unit}</td>` +
        `<td class="${off ? 'off' : ''}">${t.toFixed(0)}${unit}</td>` +
        (o ? `<td class="orig">${pick(o).toFixed(0)}${unit}</td>` : '') +
        '</tr>'
      )
    }
    // Hue only means something when there is colour to have a hue.
    const hueRow = a.saturation > 3 && b.saturation > 3
    this.readout.innerHTML =
      `<table><thead><tr><th></th><th class="src">Source</th><th class="tgt">Matched</th>${o ? '<th class="orig">Original</th>' : ''}</tr></thead><tbody>` +
      row('Shadows', (l) => l.p05, '', 3, 'Luma at the 5th percentile (0–100)') +
      row('Mids', (l) => l.p50, '', 3, 'Median luma (0–100)') +
      row('Highlights', (l) => l.p95, '', 3, 'Luma at the 95th percentile (0–100)') +
      row('Saturation', (l) => l.saturation, '', 2, 'Average distance from the vectorscope centre (x100)') +
      (hueRow ? row('Hue', (l) => l.hue, '°', 4, 'Average hue angle on the vectorscope') : '') +
      '</tbody></table>'
  }
}
