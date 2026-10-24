/**
 * Draws the scopes strip: an overlaid hue x saturation map, a tone scope
 * (overlaid luma histograms, or an RGB parade per image) and a readout table.
 * Source is blue and the matched target amber (the role colours used across
 * the panel); where the two overlap the hue map goes white, so "matched"
 * reads as "one cloud". The target as shot can be added in grey. What is
 * drawn never depends on the image view (Before / Split / After) — the key
 * always says exactly what is shown. Data comes from core/scopes.ts.
 *
 * The scopes are also range pickers (Lumetri "Color/Gray" style). On the hue
 * map, drag a box for a hue + saturation range, or use the hue strip below
 * and the saturation bar beside it like Lumetri's H and S sliders; on the
 * tone scope, drag for a brightness range. Dragging a range's edge moves
 * that edge, dragging inside moves the whole range, and a plain click clears
 * that part of the range. The app turns everything outside it grey.
 */
import { type Vec3, clamp01, encodeRgb, oklabToLinear } from '../core/color.ts'
import {
  type Density,
  type LumaStats,
  type PixelData,
  type Qualifier,
  type QualifierPlanes,
  SKIN_HUE_DEG,
  hueMap,
  hueToX,
  lumaStats,
  parade,
  xToHue,
} from '../core/scopes.ts'

type RGB = readonly [number, number, number]
const SRC: RGB = [74, 168, 255]
const TGT: RGB = [240, 166, 64]
const ORIG: RGB = [150, 150, 150]
const CHANNELS: RGB[] = [
  [255, 72, 72],
  [72, 222, 104],
  [84, 134, 255],
]

/** One image's pixels on the scopes: the sampled pixel offsets and its luma/hue/saturation planes. */
export interface ScopeLayer {
  px: PixelData
  width: number
  planes: QualifierPlanes
  idx: number[]
}

export type ToneScope = 'luma' | 'parade'

/** Share of each frame inside the range (0–1), for the readout. */
export interface RangeShares {
  source: number
  matched: number
  original: number | null
}

function css(v: RGB, a = 1): string {
  return `rgba(${v[0]},${v[1]},${v[2]},${a})`
}

const dprOf = () => window.devicePixelRatio || 1
const DRAG_MIN_PX = 3
/** How close (CSS px) to a range edge grabs the edge instead of starting a new range. */
const EDGE_PX = 5

/** A colour of the given Oklab hue and chroma (x100) at a mid lightness, as CSS. */
function swatch(hue: number, sat: number): string {
  const h = (hue * Math.PI) / 180
  const c = sat / 100
  const rgb = encodeRgb(oklabToLinear([0.7, c * Math.cos(h), c * Math.sin(h)]).map(clamp01) as Vec3)
  return `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`
}

let stripCache: HTMLCanvasElement | null = null
/** The real colours along the hue axis, 360 px wide. */
function hueStrip(): HTMLCanvasElement {
  if (stripCache) return stripCache
  const c = document.createElement('canvas')
  c.width = 360
  c.height = 1
  const ctx = c.getContext('2d')!
  for (let x = 0; x < 360; x++) {
    ctx.fillStyle = swatch(xToHue((x + 0.5) / 360), 13)
    ctx.fillRect(x, 0, 1, 1)
  }
  return (stripCache = c)
}

type Edge = 'hue0' | 'hue1' | 'sat0' | 'sat1' | 'luma0' | 'luma1'
type Region = 'plot' | 'strip' | 'sbar' | 'tone'
interface Drag {
  region: Region
  mode: 'new' | 'edge' | 'move'
  edge: Edge | null
  x0: number
  y0: number
  moved: boolean
  q0: Qualifier
}

export class ScopesView {
  /** Hue map zoom: the top edge is 32 / zoom saturation. */
  zoom = 2
  tone: ToneScope = 'luma'
  qualifier: Qualifier | null = null
  shares: RangeShares | null = null
  /** Called while dragging (and on a clearing click) with the new range, or null for none. */
  onRange: ((q: Qualifier | null) => void) | null = null
  private last: [ScopeLayer, ScopeLayer, ScopeLayer | null] | null = null
  private stats: [LumaStats, LumaStats, LumaStats | null] | null = null
  private drag: Drag | null = null

  constructor(
    private hCanvas: HTMLCanvasElement,
    private tCanvas: HTMLCanvasElement,
    private readout: HTMLElement,
  ) {
    hCanvas.addEventListener('mousedown', (e) => this.start(hCanvas, e))
    tCanvas.addEventListener('mousedown', (e) => this.start(tCanvas, e))
    for (const c of [hCanvas, tCanvas]) c.addEventListener('mousemove', (e) => this.hover(c, e))
    window.addEventListener('mousemove', (e) => this.move(e))
    window.addEventListener('mouseup', () => this.end())
    // Redraw at the new size, so drawing and picking always share one geometry.
    let pending = false
    const ro = new ResizeObserver(() => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        if (this.last) this.draw()
      })
    })
    ro.observe(hCanvas)
    ro.observe(tCanvas)
  }

  get satMax(): number {
    return 32 / this.zoom
  }

  // ------------------------------------------------------------------ geometry

  /** Hue map layout, device px: plot, hue strip under it, saturation bar left of it. */
  private hg() {
    const d = dprOf()
    const W = this.hCanvas.width
    const H = this.hCanvas.height
    return { d, W, H, x0: 18 * d, x1: W - 3 * d, y0: 4 * d, y1: H - 21 * d, ty0: H - 15 * d, ty1: H - 4 * d, sx0: 5 * d, sx1: 12 * d }
  }

  private hueAt(x: number): number {
    const g = this.hg()
    return xToHue(Math.min(1 - 1e-6, Math.max(0, (x - g.x0) / (g.x1 - g.x0))))
  }

  private hueX(h: number): number {
    const g = this.hg()
    return g.x0 + hueToX(h) * (g.x1 - g.x0)
  }

  /** The hue range as map fractions, end after start (past 1 if it wraps the seam). */
  private hueSpan(q: Qualifier): [number, number] {
    if (!q.hue) return [0, 1]
    const f0 = hueToX(q.hue[0])
    let f1 = hueToX(q.hue[1])
    if (f1 < f0) f1 += 1
    return [f0, f1]
  }

  private satAt(y: number): number {
    const g = this.hg()
    return Math.min(this.satMax, Math.max(0, (this.satMax * (g.y1 - y)) / (g.y1 - g.y0)))
  }

  private satY(s: number): number {
    const g = this.hg()
    return g.y1 - Math.min(1, s / this.satMax) * (g.y1 - g.y0)
  }

  /** Tone scope layout: luma runs across (histogram) or up (parade). */
  private tg() {
    const d = dprOf()
    const W = this.tCanvas.width
    const H = this.tCanvas.height
    return this.tone === 'luma'
      ? { d, W, H, x0: 0, x1: W - 1, y0: 4 * d, y1: H - 18 * d, bx0: 0, bx1: 0 }
      : { d, W, H, x0: 16 * d, x1: W, y0: 4 * d, y1: H - 4 * d, bx0: 5 * d, bx1: 10 * d }
  }

  private lumaAt(x: number, y: number): number {
    const g = this.tg()
    const t = this.tone === 'luma' ? (x - g.x0) / (g.x1 - g.x0) : (g.y1 - y) / (g.y1 - g.y0)
    return Math.min(100, Math.max(0, t * 100))
  }

  /** Canvas position of a luma value: x for the histogram, y for the parade. */
  private lumaPos(v: number): number {
    const g = this.tg()
    return this.tone === 'luma' ? g.x0 + (v / 100) * (g.x1 - g.x0) : g.y1 - (v / 100) * (g.y1 - g.y0)
  }

  // -------------------------------------------------------------- range picking

  private local(c: HTMLCanvasElement, e: MouseEvent): [number, number] {
    const r = c.getBoundingClientRect()
    const d = dprOf()
    return [(e.clientX - r.left) * d, (e.clientY - r.top) * d]
  }

  private regionAt(c: HTMLCanvasElement, x: number, y: number): Region {
    if (c === this.tCanvas) return 'tone'
    const g = this.hg()
    if (y >= g.ty0 - 3 * g.d) return 'strip'
    if (x < g.x0 - 2 * g.d) return 'sbar'
    return 'plot'
  }

  /** What a press at (x, y) would grab: an edge, the range itself (to move), or nothing (new range). */
  private grab(region: Region, x: number, y: number): { mode: Drag['mode']; edge: Edge | null } {
    const q = this.qualifier
    const near = EDGE_PX * dprOf()
    if (!q) return { mode: 'new', edge: null }
    if (region === 'tone') {
      if (!q.luma) return { mode: 'new', edge: null }
      const p = this.tone === 'luma' ? x : y
      const a = this.lumaPos(q.luma[0])
      const b = this.lumaPos(q.luma[1])
      if (Math.abs(p - a) <= near) return { mode: 'edge', edge: 'luma0' }
      if (Math.abs(p - b) <= near) return { mode: 'edge', edge: 'luma1' }
      return { mode: Math.min(a, b) < p && p < Math.max(a, b) ? 'move' : 'new', edge: null }
    }
    const g = this.hg()
    const [f0, f1] = this.hueSpan(q)
    const xa = g.x0 + f0 * (g.x1 - g.x0)
    const xb = g.x0 + f1 * (g.x1 - g.x0)
    // Positions right of the seam count as wrapped too, so wrapped ranges grab.
    const xs = x < xa && f1 > 1 ? x + (g.x1 - g.x0) : x
    const inHue = xa - near <= xs && xs <= xb + near
    const ya = this.satY(q.sat?.[0] ?? 0)
    const yb = this.satY(q.sat?.[1] ?? this.satMax)
    const inSat = yb - near <= y && y <= ya + near
    if ((region === 'plot' || region === 'strip') && q.hue) {
      if ((region === 'strip' || inSat) && Math.abs(xs - xa) <= near) return { mode: 'edge', edge: 'hue0' }
      if ((region === 'strip' || inSat) && Math.abs(xs - xb) <= near) return { mode: 'edge', edge: 'hue1' }
    }
    if ((region === 'plot' || region === 'sbar') && q.sat) {
      if ((region === 'sbar' || inHue) && Math.abs(y - ya) <= near) return { mode: 'edge', edge: 'sat0' }
      if ((region === 'sbar' || inHue) && Math.abs(y - yb) <= near) return { mode: 'edge', edge: 'sat1' }
    }
    if (region === 'plot' && (q.hue || q.sat) && inHue && inSat) return { mode: 'move', edge: null }
    if (region === 'strip' && q.hue && inHue) return { mode: 'move', edge: null }
    if (region === 'sbar' && q.sat && inSat) return { mode: 'move', edge: null }
    return { mode: 'new', edge: null }
  }

  private hover(c: HTMLCanvasElement, e: MouseEvent): void {
    if (this.drag || !this.last) return
    const [x, y] = this.local(c, e)
    const region = this.regionAt(c, x, y)
    const { mode, edge } = this.grab(region, x, y)
    const vertical = edge === 'sat0' || edge === 'sat1' || (region === 'tone' && this.tone === 'parade')
    c.style.cursor = mode === 'edge' ? (vertical ? 'ns-resize' : 'ew-resize') : mode === 'move' ? 'move' : 'crosshair'
  }

  private start(c: HTMLCanvasElement, e: MouseEvent): void {
    if (e.button !== 0 || !this.last) return
    const [x, y] = this.local(c, e)
    const region = this.regionAt(c, x, y)
    const { mode, edge } = this.grab(region, x, y)
    this.drag = { region, mode, edge, x0: x, y0: y, moved: false, q0: { ...(this.qualifier ?? {}) } }
    e.preventDefault()
  }

  private move(e: MouseEvent): void {
    const d = this.drag
    if (!d) return
    const c = d.region === 'tone' ? this.tCanvas : this.hCanvas
    const [x, y] = this.local(c, e)
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < DRAG_MIN_PX * dprOf()) return
    d.moved = true
    const q: Qualifier = { ...d.q0 }
    if (d.mode === 'edge') this.dragEdge(d, q, x, y)
    else if (d.mode === 'move') this.dragMove(d, q, x, y)
    else this.dragNew(d, q, x, y)
    this.setQualifier(q)
  }

  private dragNew(d: Drag, q: Qualifier, x: number, y: number): void {
    if (d.region === 'tone') {
      const a = this.lumaAt(d.x0, d.y0)
      const b = this.lumaAt(x, y)
      q.luma = [Math.min(a, b), Math.max(a, b)]
      return
    }
    if (d.region !== 'sbar') {
      const [xa, xb] = [Math.min(d.x0, x), Math.max(d.x0, x)]
      q.hue = [this.hueAt(xa), this.hueAt(Math.max(xb, xa + 2 * dprOf()))]
    }
    if (d.region !== 'strip') {
      const lo = this.satAt(Math.max(d.y0, y))
      const hi = this.satAt(Math.min(d.y0, y))
      // From the bottom means "from grey"; to the top means "and anything more colourful".
      q.sat = [lo < this.satMax * 0.03 ? 0 : lo, hi > this.satMax * 0.97 ? 100 : hi]
    }
  }

  private dragEdge(d: Drag, q: Qualifier, x: number, y: number): void {
    const e = d.edge!
    const key = e.slice(0, -1) as 'luma' | 'sat' | 'hue'
    const i = e.endsWith('0') ? 0 : 1
    let r: [number, number]
    if (key === 'hue') {
      // Hue edges work in map fractions so the range never flips the long way round.
      const g = this.hg()
      const f = Math.min(1 - 1e-6, Math.max(0, (x - g.x0) / (g.x1 - g.x0)))
      r = this.hueSpan(q)
      r[i] = i === 1 && r[1] > 1 && f < r[0] ? f + 1 : f
    } else {
      r = [...q[key]!] as [number, number]
      const v = key === 'luma' ? this.lumaAt(x, y) : this.satAt(y)
      r[i] = key === 'sat' && i === 1 && v > this.satMax * 0.97 ? 100 : v
    }
    if (r[0] > r[1]) {
      // Dragged past the other edge: carry on as that edge.
      r.reverse()
      d.edge = `${key}${1 - i}` as Edge
    }
    q[key] = key === 'hue' ? [xToHue(r[0]), xToHue(Math.max(r[1], r[0] + 0.004))] : r
    if (d.edge !== e) d.q0 = { ...d.q0, [key]: q[key] }
  }

  private dragMove(d: Drag, q: Qualifier, x: number, y: number): void {
    if (d.region === 'tone') {
      const [a, b] = d.q0.luma!
      const dv = Math.max(-a, Math.min(100 - b, this.lumaAt(x, y) - this.lumaAt(d.x0, d.y0)))
      q.luma = [a + dv, b + dv]
      return
    }
    const g = this.hg()
    if (d.q0.hue && d.region !== 'sbar') {
      const dh = ((x - d.x0) / (g.x1 - g.x0)) * 360
      q.hue = [(d.q0.hue[0] + dh + 360) % 360, (d.q0.hue[1] + dh + 360) % 360]
    }
    if (d.q0.sat && d.region !== 'strip') {
      const [a, b] = d.q0.sat
      const ds = Math.max(-a, ((d.y0 - y) / (g.y1 - g.y0)) * this.satMax)
      q.sat = [a + ds, b >= 100 ? 100 : b + ds]
    }
  }

  private end(): void {
    const d = this.drag
    if (!d) return
    this.drag = null
    if (d.moved) return
    // A plain click clears that part of the range.
    const q: Qualifier = { ...(this.qualifier ?? {}) }
    if (d.region === 'tone') delete q.luma
    if (d.region === 'plot' || d.region === 'strip') delete q.hue
    if (d.region === 'plot' || d.region === 'sbar') delete q.sat
    this.setQualifier(q.luma || q.hue || q.sat ? q : null)
  }

  /** Redraw with the last data (e.g. after the shares changed). */
  refresh(): void {
    if (this.last) this.render(...this.last)
  }

  setQualifier(q: Qualifier | null): void {
    this.qualifier = q
    if (this.last) this.draw()
    this.onRange?.(q)
  }

  // ------------------------------------------------------------------- drawing

  private fit(c: HTMLCanvasElement): [number, number] {
    const d = dprOf()
    const w = Math.max(1, Math.round(c.clientWidth * d))
    const h = Math.max(1, Math.round(c.clientHeight * d))
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    return [w, h]
  }

  clear(message: string): void {
    this.last = null
    this.stats = null
    for (const c of [this.hCanvas, this.tCanvas]) {
      const [w, h] = this.fit(c)
      c.getContext('2d')!.clearRect(0, 0, w, h)
    }
    this.readout.innerHTML = `<p class="scope-empty">${message}</p>`
  }

  /** `original` (the target as shot) is optional, drawn in grey behind the others. */
  render(source: ScopeLayer, matched: ScopeLayer, original: ScopeLayer | null): void {
    this.last = [source, matched, original]
    this.stats = [lumaStats(source.planes, source.idx), lumaStats(matched.planes, matched.idx), original ? lumaStats(original.planes, original.idx) : null]
    this.draw()
  }

  private draw(): void {
    const [s, m, o] = this.last!
    const [ss, ms, os] = this.stats!
    this.drawHueMap(s, m, o)
    if (this.tone === 'luma') this.drawLuma(ss, ms, os)
    else this.drawParade(o ? [s, m, o] : [s, m])
    this.drawReadout(ss, ms, os)
  }

  private densityImage(d: Density, col: RGB, opacity: number): HTMLCanvasElement {
    const img = new ImageData(d.width, d.height)
    const lm = Math.log1p(d.max)
    for (let i = 0; i < d.counts.length; i++) {
      const c = d.counts[i]
      if (!c) continue
      const t = Math.pow(Math.log1p(c) / lm, 0.7)
      img.data[i * 4] = col[0]
      img.data[i * 4 + 1] = col[1]
      img.data[i * 4 + 2] = col[2]
      img.data[i * 4 + 3] = Math.round((70 + 185 * t) * opacity)
    }
    const off = document.createElement('canvas')
    off.width = d.width
    off.height = d.height
    off.getContext('2d')!.putImageData(img, 0, 0)
    return off
  }

  private drawHueMap(a: ScopeLayer, b: ScopeLayer, o: ScopeLayer | null): void {
    const [W, H] = this.fit(this.hCanvas)
    const ctx = this.hCanvas.getContext('2d')!
    const g = this.hg()
    const d = g.d
    const pw = g.x1 - g.x0
    const ph = g.y1 - g.y0
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, W, H)

    // Grid: every 30° of hue, every quarter of the saturation range.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = d
    ctx.beginPath()
    for (let h = 0; h < 360; h += 30) {
      const x = Math.round(this.hueX(h)) + 0.5
      ctx.moveTo(x, g.y0)
      ctx.lineTo(x, g.y1)
    }
    for (let k = 1; k < 4; k++) {
      const y = Math.round(g.y1 - (k / 4) * ph) + 0.5
      ctx.moveTo(g.x0, y)
      ctx.lineTo(g.x1, y)
    }
    ctx.stroke()

    // Densities on a grid ~1.5 css px a cell, scaled up softly.
    const gw = Math.max(48, Math.round(pw / (1.5 * d)))
    const gh = Math.max(24, Math.round(ph / (1.5 * d)))
    const map = (l: ScopeLayer) => hueMap(l.planes, l.idx, gw, gh, this.satMax)
    ctx.imageSmoothingEnabled = true
    if (o) {
      const od = map(o)
      if (od.max) ctx.drawImage(this.densityImage(od, ORIG, 0.55), g.x0, g.y0, pw, ph)
    }
    // Source and matched target added on top of each other: overlap turns white.
    ctx.globalCompositeOperation = 'lighter'
    for (const [l, col] of [
      [a, SRC],
      [b, TGT],
    ] as const) {
      const dd = map(l)
      if (dd.max) ctx.drawImage(this.densityImage(dd, col, 1), g.x0, g.y0, pw, ph)
    }
    ctx.globalCompositeOperation = 'source-over'

    // Skin hue.
    const sx = Math.round(this.hueX(SKIN_HUE_DEG)) + 0.5
    ctx.strokeStyle = 'rgba(255,200,160,0.4)'
    ctx.setLineDash([4 * d, 3 * d])
    ctx.beginPath()
    ctx.moveTo(sx, g.y0)
    ctx.lineTo(sx, g.y1)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.font = `${9 * d}px system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(255,200,160,0.6)'
    ctx.fillText('skin', sx + 3 * d, g.y0 + 1 * d)

    // Hue strip (H) and saturation bar (S): Lumetri-style sliders on the map's axes.
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(hueStrip(), g.x0, g.ty0, pw, g.ty1 - g.ty0)
    const q = this.qualifier
    const hueC = q?.hue ? xToHue(((this.hueSpan(q)[0] + this.hueSpan(q)[1]) / 2) % 1) : SKIN_HUE_DEG
    const grad = ctx.createLinearGradient(0, g.y1, 0, g.y0)
    for (let k = 0; k <= 4; k++) grad.addColorStop(k / 4, swatch(hueC, (k / 4) * this.satMax))
    ctx.fillStyle = grad
    ctx.fillRect(g.sx0, g.y0, g.sx1 - g.sx0, ph)

    if (q && (q.hue || q.sat)) this.drawBox(ctx, q)
  }

  /** The picked hue/saturation range: the rest of the map dimmed, handles on the H and S sliders. */
  private drawBox(ctx: CanvasRenderingContext2D, q: Qualifier): void {
    const g = this.hg()
    const d = g.d
    const pw = g.x1 - g.x0
    const [f0, f1] = this.hueSpan(q)
    const ya = this.satY(q.sat?.[0] ?? 0)
    const yb = this.satY(q.sat?.[1] ?? this.satMax)
    // A range across the seam is two boxes.
    const spans: Array<[number, number]> = f1 > 1 ? [[f0, 1], [0, f1 - 1]] : [[f0, f1]]
    const rects = spans.map(([u, v]) => [g.x0 + u * pw, g.x0 + v * pw] as [number, number])

    ctx.save()
    ctx.beginPath()
    ctx.rect(g.x0, g.y0, pw, g.y1 - g.y0)
    for (const [xa, xb] of rects) ctx.rect(xa, yb, xb - xa, ya - yb)
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fill('evenodd')
    ctx.setLineDash([4 * d, 3 * d])
    ctx.lineWidth = 1.2 * d
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    for (const [xa, xb] of rects) ctx.strokeRect(xa, yb, xb - xa, ya - yb)
    ctx.setLineDash([])

    // Dim the sliders outside the range and mark its edges.
    ctx.fillStyle = 'rgba(13,13,13,0.7)'
    if (q.hue) {
      ctx.beginPath()
      ctx.rect(g.x0, g.ty0, pw, g.ty1 - g.ty0)
      for (const [xa, xb] of rects) ctx.rect(xa, g.ty0, xb - xa, g.ty1 - g.ty0)
      ctx.fill('evenodd')
      ctx.fillStyle = '#fff'
      for (const f of [f0, f1 % 1 || (f1 > 0 ? 1 : 0)]) {
        const x = g.x0 + f * pw
        ctx.fillRect(x - d, g.ty0 - 2 * d, 2 * d, g.ty1 - g.ty0 + 4 * d)
      }
    }
    if (q.sat) {
      ctx.fillStyle = 'rgba(13,13,13,0.7)'
      ctx.fillRect(g.sx0, g.y0, g.sx1 - g.sx0, yb - g.y0)
      ctx.fillRect(g.sx0, ya, g.sx1 - g.sx0, g.y1 - ya)
      ctx.fillStyle = '#fff'
      for (const y of q.sat[0] > 0 ? [ya, yb] : [yb]) ctx.fillRect(g.sx0 - 2 * d, y - d, g.sx1 - g.sx0 + 4 * d, 2 * d)
    }
    ctx.restore()
  }

  private drawLuma(a: LumaStats, b: LumaStats, o: LumaStats | null): void {
    const [W, H] = this.fit(this.tCanvas)
    const ctx = this.tCanvas.getContext('2d')!
    const g = this.tg()
    const d = g.d
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, W, H)
    const plotH = g.y1 - g.y0
    // Square root so small populations (deep shadows, highlights) stay visible.
    let max = 0
    for (let i = 0; i <= 100; i++) max = Math.max(max, Math.sqrt(a.hist[i]), Math.sqrt(b.hist[i]), o ? Math.sqrt(o.hist[i]) : 0)
    const X = (v: number) => this.lumaPos(v)
    const Y = (f: number) => g.y0 + plotH * (1 - (max ? Math.sqrt(f) / max : 0))

    // Grid every 10 IRE.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = d
    ctx.beginPath()
    for (let v = 0; v <= 100; v += 10) {
      ctx.moveTo(X(v), g.y0)
      ctx.lineTo(X(v), g.y1)
    }
    ctx.stroke()

    if (o) {
      // Original as a dashed grey outline only, behind the two that matter.
      ctx.beginPath()
      for (let i = 0; i <= 100; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i), Y(o.hist[i]))
      ctx.setLineDash([4 * d, 3 * d])
      ctx.strokeStyle = css(ORIG, 0.8)
      ctx.lineWidth = 1.2 * d
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
      ctx.lineWidth = 1.2 * d
      ctx.stroke()
    }

    const q = this.qualifier
    if (q?.luma) {
      // The picked brightness range: the rest dimmed, handles at the top.
      const [lo, hi] = q.luma.map(X)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(g.x0, g.y0, lo - g.x0, plotH)
      ctx.fillRect(hi, g.y0, g.x1 - hi, plotH)
      this.edgeLines(ctx, [lo, hi], 'v', g.y0, g.y1)
    }

    // Percentile ticks: source above the axis, target below.
    for (const [s, col, dir] of [
      [a, SRC, -1],
      [b, TGT, 1],
    ] as const) {
      ctx.strokeStyle = css(col)
      ctx.lineWidth = 1.5 * d
      ctx.beginPath()
      for (const v of [s.p05, s.p50, s.p95]) {
        ctx.moveTo(X(v), g.y1)
        ctx.lineTo(X(v), g.y1 + dir * 6 * d)
      }
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = `${9 * d}px system-ui, sans-serif`
    ctx.textBaseline = 'top'
    for (const v of [0, 50, 100]) {
      const t = String(v)
      const tw = ctx.measureText(t).width
      ctx.fillText(t, Math.min(W - tw, Math.max(0, X(v) - tw / 2)), g.y1 + 5 * d)
    }
  }

  /** Dashed range edges with a solid handle tab at one end. */
  private edgeLines(ctx: CanvasRenderingContext2D, at: number[], dir: 'v' | 'h', from: number, to: number): void {
    const d = dprOf()
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.setLineDash([4 * d, 3 * d])
    ctx.lineWidth = 1.2 * d
    ctx.beginPath()
    for (const p of at) {
      if (dir === 'v') {
        ctx.moveTo(p, from)
        ctx.lineTo(p, to)
      } else {
        ctx.moveTo(from, p)
        ctx.lineTo(to, p)
      }
    }
    ctx.stroke()
    ctx.fillStyle = '#fff'
    for (const p of at) {
      if (dir === 'v') ctx.fillRect(p - 2 * d, from, 4 * d, 7 * d)
      else ctx.fillRect(from - 6 * d, p - 2 * d, 7 * d, 4 * d)
    }
    ctx.restore()
  }

  /** RGB parade per image, side by side: source, matched (and the original). */
  private drawParade(layers: ScopeLayer[]): void {
    const [W, H] = this.fit(this.tCanvas)
    const ctx = this.tCanvas.getContext('2d')!
    const g = this.tg()
    const d = g.d
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, W, H)
    const gap = 6 * d
    const n = layers.length
    const pw = (g.x1 - g.x0 - gap * (n - 1)) / n
    const ph = g.y1 - g.y0
    const names: Array<[string, RGB]> = [
      ['Source', SRC],
      ['Matched', TGT],
      ['Original', ORIG],
    ]
    const Y = (v: number) => this.lumaPos(v)
    ctx.imageSmoothingEnabled = true
    layers.forEach((l, k) => {
      const px0 = g.x0 + k * (pw + gap)
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#141414'
      ctx.fillRect(px0, g.y0, pw, ph)
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'
      ctx.lineWidth = d
      ctx.beginPath()
      for (let v = 0; v <= 100; v += 25) {
        const y = Math.round(Y(v)) + 0.5
        ctx.moveTo(px0, y)
        ctx.lineTo(px0 + pw, y)
      }
      ctx.stroke()
      const cw = (pw - 4 * d) / 3
      const cols = Math.max(8, Math.round(cw / (1.5 * d)))
      const rows = Math.max(24, Math.round(ph / (1.5 * d)))
      const chans = parade(l.px, l.width, l.idx, cols, rows)
      ctx.globalCompositeOperation = 'lighter'
      chans.forEach((ch, c) => {
        if (ch.max) ctx.drawImage(this.densityImage(ch, CHANNELS[c], k === 2 ? 0.6 : 1), px0 + c * (cw + 2 * d), g.y0, cw, ph)
      })
      ctx.globalCompositeOperation = 'source-over'
      const [name, col] = names[k]
      ctx.font = `${9 * d}px system-ui, sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillStyle = css(col, 0.95)
      ctx.fillText(name, px0 + 4 * d, g.y0 + 2 * d)
    })

    // Luma slider down the left edge, then the picked range across every panel.
    ctx.fillStyle = '#262626'
    ctx.fillRect(g.bx0, g.y0, g.bx1 - g.bx0, ph)
    const q = this.qualifier
    if (q?.luma) {
      const [lo, hi] = q.luma.map(Y)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(g.x0, g.y0, g.x1 - g.x0, hi - g.y0)
      ctx.fillRect(g.x0, lo, g.x1 - g.x0, g.y1 - lo)
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillRect(g.bx0, hi, g.bx1 - g.bx0, lo - hi)
      this.edgeLines(ctx, [lo, hi], 'h', g.x0, g.x1)
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
    const hueRow = a.saturation > 2 && b.saturation > 2
    this.readout.innerHTML =
      `<table><thead><tr><th></th><th class="src">Source</th><th class="tgt">Matched</th>${o ? '<th class="orig">Original</th>' : ''}</tr></thead><tbody>` +
      row('Shadows', (l) => l.p05, '', 3, 'Luma at the 5th percentile (0–100)') +
      row('Mids', (l) => l.p50, '', 3, 'Median luma (0–100)') +
      row('Highlights', (l) => l.p95, '', 3, 'Luma at the 95th percentile (0–100)') +
      row('Saturation', (l) => l.saturation, '', 1, 'Average height on the hue map (Oklab chroma x100)') +
      (hueRow ? row('Hue', (l) => l.hue, '°', 4, 'Average position across the hue map (Oklab degrees)') : '') +
      this.shareRow() +
      '</tbody></table>'
  }

  /** How much of each frame falls inside the picked range: similar numbers, similar picture. */
  private shareRow(): string {
    const sh = this.shares
    if (!sh || !this.qualifier) return ''
    const pc = (v: number) => `${Math.round(v * 100)}%`
    const off = Math.abs(sh.matched - sh.source) > 0.05
    return (
      '<tr class="share" title="Share of the scoped area (Whole frame / Matched areas / Selected point) inside the picked range"><th>In range</th>' +
      `<td>${pc(sh.source)}</td><td class="${off ? 'off' : ''}">${pc(sh.matched)}</td>` +
      (sh.original !== null && this.last?.[2] ? `<td class="orig">${pc(sh.original)}</td>` : '') +
      '</tr>'
    )
  }
}
