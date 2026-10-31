/**
 * One frame (source or target) on a canvas: draws the image, the numbered
 * point markers and a magnifier loupe, and turns mouse input into image-space
 * coordinates. Knows nothing about colour.
 *
 * Points: click to place one at the default size, or press and drag out to
 * draw it at any size. Drag inside a point to move it, drag its edge to
 * resize it, right-click to delete it.
 *
 * Zoom: scroll wheel zooms around the cursor; Space+drag or middle-drag pans
 * (left-drag is drawing); the badge in the corner returns to fit.
 *
 * Split: drag the divider (or its grip) to wipe between before and after;
 * double-click it to centre it again.
 */

export interface Marker {
  id: number
  label: string
  x: number
  y: number
  colour: string
  selected: boolean
  pending: boolean
  ignored: boolean
  /** Suggested by Auto rather than placed by hand. */
  auto: boolean
  /** Switched off in the list: drawn faded. */
  off: boolean
  /** Sample radius in image pixels. */
  r: number
}

export interface FrameViewEvents {
  /** `r` is set when the point was drawn by dragging (image px). */
  pick(x: number, y: number, r?: number): void
  move(id: number, x: number, y: number): void
  resize(id: number, r: number): void
  select(id: number | null): void
  remove(id: number): void
  /** The view's scale changed: screen (device) px per image px. */
  scale?(devicePxPerImagePx: number): void
}

export type ViewMode = 'original' | 'matched' | 'split'

const LOUPE_PX = 132
const LOUPE_ZOOM = 5
const DRAG_THRESHOLD = 3
const MAX_ZOOM = 32
/** How close (CSS px) to the split divider or its grip a press grabs it. */
const SPLIT_GRAB = 9
/** Above this many screen px per image px the loupe adds nothing. */
const LOUPE_MAX_SCALE = 2

export class FrameView {
  private ctx: CanvasRenderingContext2D
  private image: CanvasImageSource | null = null
  private overlay: CanvasImageSource | null = null
  private isoBase: CanvasImageSource | null = null
  private isoOverlay: CanvasImageSource | null = null
  private imgW = 0
  private imgH = 0
  /** CSS px per image px at zoom 1 (whole frame fits). */
  private fit = 1
  private zoom = 1
  /** Image coordinates of the view's top-left corner. */
  private vx = 0
  private vy = 0
  private cssW = 0
  private cssH = 0
  private markers: Marker[] = []
  private hover: { x: number; y: number } | null = null
  private drag: { id: number; mode: 'move' | 'resize'; cx: number; cy: number; startX: number; startY: number; moved: boolean } | null = null
  private down: { x: number; y: number; ix: number; iy: number; vx: number; vy: number; panning: boolean; button: number; drawR: number } | null = null
  /** Space held while the cursor is over this frame: left-drag pans. */
  private space = false
  private overCanvas = false
  private badge: HTMLButtonElement
  mode: ViewMode = 'original'
  /** Split view: where the divider sits, as a fraction of the view's width. */
  private splitAt = 0.5
  private splitDrag = false
  /** Radius a click would place (image px): drawn in the loupe. */
  radius = 10
  private markersVisible = true

  constructor(
    private wrap: HTMLElement,
    private canvas: HTMLCanvasElement,
    private ev: FrameViewEvents,
  ) {
    this.ctx = canvas.getContext('2d')!
    this.badge = document.createElement('button')
    this.badge.className = 'zoom-badge'
    this.badge.title = 'Zoomed — click to fit the whole frame'
    this.badge.hidden = true
    this.badge.addEventListener('click', () => this.resetZoom())
    wrap.appendChild(this.badge)

    new ResizeObserver(() => this.layout()).observe(wrap)
    canvas.addEventListener('mousedown', (e) => this.onDown(e))
    window.addEventListener('mousemove', (e) => this.onMove(e))
    window.addEventListener('mouseup', (e) => this.onUp(e))
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    canvas.addEventListener('mouseenter', () => (this.overCanvas = true))
    canvas.addEventListener('mouseleave', () => {
      this.overCanvas = false
      this.hover = null
      this.render()
    })
    // Space = temporary hand tool. Swallow it while over the frame, or it would
    // scroll the panel and "click" whichever button last had focus.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Space' || !this.overCanvas || (e.target as HTMLElement).tagName === 'INPUT') return
        e.preventDefault()
        if (!this.space) {
          this.space = true
          this.updateCursor()
        }
      },
      true,
    )
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.code !== 'Space' || !this.space) return
        e.preventDefault()
        this.space = false
        this.updateCursor()
      },
      true,
    )
    canvas.addEventListener('dblclick', (e) => {
      if (!this.nearSplit(e)) return
      this.splitAt = 0.5
      this.render()
    })
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const p = this.toImage(e)
      const hit = this.hitTest(p.x, p.y)
      if (hit) this.ev.remove(hit.id)
    })
  }

  get hasImage(): boolean {
    return this.image !== null
  }

  setImage(img: CanvasImageSource | null, w = 0, h = 0): void {
    if (w !== this.imgW || h !== this.imgH) {
      this.zoom = 1
      this.vx = 0
      this.vy = 0
    }
    this.image = img
    this.imgW = w
    this.imgH = h
    this.overlay = null
    this.layout()
  }

  /** The matched preview. Any resolution; drawn stretched over the frame. */
  setOverlay(img: CanvasImageSource | null): void {
    this.overlay = img
    this.render()
  }

  /**
   * Color/Gray versions of the image and of the matched preview (any
   * resolution), drawn in their place while a scope range is picked; null
   * for none. The loupe keeps reading the real pixels.
   */
  setIsolation(base: CanvasImageSource | null, overlay: CanvasImageSource | null): void {
    this.isoBase = base
    this.isoOverlay = overlay
    this.render()
  }

  setMarkers(m: Marker[]): void {
    this.markers = m
    this.render()
  }

  setMarkersVisible(on: boolean): void {
    this.markersVisible = on
    this.render()
  }

  resetZoom(): void {
    this.zoom = 1
    this.vx = 0
    this.vy = 0
    this.updateBadge()
    this.layout()
  }

  private get zoomed(): boolean {
    return this.zoom > 1.001
  }

  layout(): void {
    const dpr = window.devicePixelRatio || 1
    const availW = this.wrap.clientWidth
    const availH = this.wrap.clientHeight
    if (!this.image || !availW || !availH) {
      this.canvas.style.display = 'none'
      return
    }
    // At fit the canvas hugs the picture (aspect kept). Zoomed in, it takes the
    // frame's whole box, so the space a letterbox would waste shows more of
    // the picture instead.
    this.fit = Math.min(availW / this.imgW, availH / this.imgH)
    this.cssW = this.zoomed ? availW : Math.round(this.imgW * this.fit)
    this.cssH = this.zoomed ? availH : Math.round(this.imgH * this.fit)
    const devW = Math.round(this.cssW * dpr)
    const devH = Math.round(this.cssH * dpr)
    this.canvas.style.display = 'block'
    this.canvas.style.width = `${this.cssW}px`
    this.canvas.style.height = `${this.cssH}px`
    // Resizing a canvas clears it; only do it when the size really changes.
    if (this.canvas.width !== devW || this.canvas.height !== devH) {
      this.canvas.width = devW
      this.canvas.height = devH
    }
    this.clampView()
    this.render()
    this.ev.scale?.(this.s * dpr)
  }

  /** CSS px per image px right now. */
  private get s(): number {
    return this.fit * this.zoom
  }

  /** Keep the picture covering the view; along an axis it can't cover yet, centre it. */
  private clampView(): void {
    const axis = (v: number, span: number, size: number) => (span >= size ? (size - span) / 2 : Math.min(Math.max(v, 0), size - span))
    this.vx = axis(this.vx, this.cssW / this.s, this.imgW)
    this.vy = axis(this.vy, this.cssH / this.s, this.imgH)
  }

  private updateBadge(): void {
    this.badge.hidden = this.zoom <= 1.001
    // Percent of actual pixels, which is what an editor thinks in.
    this.badge.textContent = `${Math.round(this.s * (window.devicePixelRatio || 1) * 100)}%  ⤢`
    this.ev.scale?.(this.s * (window.devicePixelRatio || 1))
  }

  private toImage(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    return { x: this.vx + (e.clientX - r.left) / this.s, y: this.vy + (e.clientY - r.top) / this.s }
  }

  /** The marker under a point, and whether it is its edge (resize) or body (move). */
  private hitTest(x: number, y: number): { id: number; mode: 'move' | 'resize'; m: Marker } | null {
    if (!this.markersVisible) return null
    let best: { id: number; mode: 'move' | 'resize'; m: Marker } | null = null
    let bestScore = Infinity
    for (const m of this.markers) {
      const d = Math.hypot(m.x - x, m.y - y)
      // Edge band: a few screen px either side of the ring.
      const band = Math.max(4 / this.s, m.r * 0.15)
      const bigEnough = m.r * this.s >= 7
      if (bigEnough && Math.abs(d - m.r) <= band) {
        const score = Math.abs(d - m.r)
        if (score < bestScore) {
          best = { id: m.id, mode: 'resize', m }
          bestScore = score
        }
      } else if (d <= Math.max(m.r, 9 / this.s)) {
        // Body hits rank behind edge hits on the same marker.
        const score = d + 1e6
        if (score < bestScore) {
          best = { id: m.id, mode: 'move', m }
          bestScore = score
        }
      }
    }
    return best
  }

  private updateCursor(hit?: { mode: 'move' | 'resize' } | null, onSplit = false): void {
    if (this.down?.panning) this.canvas.style.cursor = 'grabbing'
    else if (this.space) this.canvas.style.cursor = 'grab'
    else if (hit?.mode === 'resize') this.canvas.style.cursor = 'nwse-resize'
    else if (hit?.mode === 'move') this.canvas.style.cursor = 'move'
    else if (this.splitDrag || onSplit) this.canvas.style.cursor = 'ew-resize'
    else this.canvas.style.cursor = ''
  }

  /**
   * Where the mouse is on the split divider, when it shows: its 'grip'
   * (which wins over a point under it), the rest of the 'line', or null.
   */
  private onSplit(e: MouseEvent): 'grip' | 'line' | null {
    if (this.mode !== 'split' || !this.overlay || !this.image) return null
    const r = this.canvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const line = this.splitAt * r.width
    // The grip stays inside the view when the line is at an edge (drawSplit).
    const grip = Math.min(Math.max(line, 10), r.width - 10)
    if (Math.hypot(x - grip, e.clientY - r.top - r.height / 2) <= SPLIT_GRAB + 2) return 'grip'
    return Math.abs(x - line) <= SPLIT_GRAB ? 'line' : null
  }

  private nearSplit(e: MouseEvent): boolean {
    return this.onSplit(e) !== null
  }

  private inside(p: { x: number; y: number }): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < this.imgW && p.y < this.imgH
  }

  private onWheel(e: WheelEvent): void {
    if (!this.image) return
    e.preventDefault()
    const before = this.toImage(e)
    const wasZoomed = this.zoomed
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018))
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, this.zoom * factor))
    // Crossing fit <-> zoomed grows or shrinks the canvas, which moves it.
    if (this.zoomed !== wasZoomed) this.layout()
    // Keep the image point under the cursor where it was.
    const r = this.canvas.getBoundingClientRect()
    this.vx = before.x - (e.clientX - r.left) / this.s
    this.vy = before.y - (e.clientY - r.top) / this.s
    this.clampView()
    this.updateBadge()
    this.hover = this.toImage(e)
    this.render()
  }

  private onDown(e: MouseEvent): void {
    if (!this.image || (e.button !== 0 && e.button !== 1)) return
    const p = this.toImage(e)
    const split = e.button === 0 && !this.space ? this.onSplit(e) : null
    const hit = e.button === 0 && !this.space && split !== 'grip' ? this.hitTest(p.x, p.y) : null
    if (!hit && split) {
      this.splitDrag = true
      this.updateCursor()
      e.preventDefault()
      return
    }
    if (hit) {
      this.drag = { id: hit.id, mode: hit.mode, cx: hit.m.x, cy: hit.m.y, startX: e.clientX, startY: e.clientY, moved: false }
      this.ev.select(hit.id)
    } else {
      this.down = { x: e.clientX, y: e.clientY, ix: p.x, iy: p.y, vx: this.vx, vy: this.vy, panning: e.button === 1 || this.space, button: e.button, drawR: 0 }
      this.updateCursor()
    }
    e.preventDefault()
  }

  private onMove(e: MouseEvent): void {
    if (!this.image) return
    const p = this.toImage(e)
    if (this.splitDrag) {
      const r = this.canvas.getBoundingClientRect()
      this.splitAt = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      this.hover = e.target === this.canvas && this.inside(p) ? p : null
      this.render()
      return
    }
    if (this.drag) {
      if (!this.drag.moved && Math.hypot(e.clientX - this.drag.startX, e.clientY - this.drag.startY) < DRAG_THRESHOLD) return
      this.drag.moved = true
      if (this.drag.mode === 'resize') {
        this.ev.resize(this.drag.id, Math.max(1.5, Math.hypot(p.x - this.drag.cx, p.y - this.drag.cy)))
      } else {
        const x = Math.min(Math.max(p.x, 0), this.imgW - 1)
        const y = Math.min(Math.max(p.y, 0), this.imgH - 1)
        this.ev.move(this.drag.id, x, y)
      }
      this.hover = { x: p.x, y: p.y }
      this.render()
      return
    }
    if (this.down) {
      const dx = e.clientX - this.down.x
      const dy = e.clientY - this.down.y
      if (this.down.panning) {
        this.vx = this.down.vx - dx / this.s
        this.vy = this.down.vy - dy / this.s
        this.clampView()
        this.hover = null
        this.render()
        return
      }
      // Left-drag on empty space draws a point: centre where pressed, radius to the cursor.
      if (this.down.button === 0 && (this.down.drawR > 0 || Math.hypot(dx, dy) >= DRAG_THRESHOLD)) {
        this.down.drawR = Math.max(1.5, Math.hypot(p.x - this.down.ix, p.y - this.down.iy))
        this.hover = { x: this.down.ix, y: this.down.iy }
        this.render()
        return
      }
    }
    if (e.target === this.canvas && this.inside(p)) {
      this.hover = p
      const split = this.onSplit(e)
      this.updateCursor(split === 'grip' ? null : this.hitTest(p.x, p.y), split !== null)
      this.render()
    }
  }

  private onUp(e: MouseEvent): void {
    if (this.splitDrag) {
      this.splitDrag = false
      this.updateCursor(null, this.nearSplit(e))
      return
    }
    if (this.drag) {
      this.drag = null
      return
    }
    if (!this.down) return
    const d = this.down
    this.down = null
    this.updateCursor()
    if (d.panning || d.button !== 0) return
    if (d.drawR > 0) {
      if (this.inside({ x: d.ix, y: d.iy })) this.ev.pick(d.ix, d.iy, d.drawR)
      this.render()
      return
    }
    const p = this.toImage(e)
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD && this.inside(p)) this.ev.pick(p.x, p.y)
  }

  /** Draw `src` (any resolution of this frame) through the current view. */
  private drawView(src: CanvasImageSource, clipX0 = 0): void {
    const c = this.ctx
    const W = this.canvas.width
    const H = this.canvas.height
    const k = ((src as HTMLCanvasElement).width || this.imgW) / this.imgW
    const spanW = this.cssW / this.s
    const spanH = this.cssH / this.s
    if (clipX0 > 0) {
      c.save()
      c.beginPath()
      c.rect(clipX0, 0, W - clipX0, H)
      c.clip()
    }
    // The view can extend past the picture (zoomed, but not yet covering an
    // axis): draw only the part of the picture inside it.
    const sx0 = Math.max(0, this.vx)
    const sy0 = Math.max(0, this.vy)
    const sx1 = Math.min(this.imgW, this.vx + spanW)
    const sy1 = Math.min(this.imgH, this.vy + spanH)
    if (sx1 > sx0 && sy1 > sy0) {
      c.drawImage(
        src,
        sx0 * k,
        sy0 * k,
        (sx1 - sx0) * k,
        (sy1 - sy0) * k,
        ((sx0 - this.vx) / spanW) * W,
        ((sy0 - this.vy) / spanH) * H,
        ((sx1 - sx0) / spanW) * W,
        ((sy1 - sy0) / spanH) * H,
      )
    }
    if (clipX0 > 0) c.restore()
  }

  render(): void {
    const c = this.ctx
    const dpr = window.devicePixelRatio || 1
    const W = this.canvas.width
    const H = this.canvas.height
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, W, H)
    if (!this.image) return

    // Past ~3:1, show crisp pixels — that is what zooming in is for.
    c.imageSmoothingEnabled = this.s * dpr < 3
    c.imageSmoothingQuality = 'high'
    const shown = this.mode !== 'original' && this.overlay ? this.overlay : this.image
    const img = this.isoBase ?? this.image
    const ov = this.overlay ? (this.isoOverlay ?? this.overlay) : null
    if (this.mode === 'split' && ov) {
      const x = Math.round(W * this.splitAt)
      this.drawView(img)
      if (x < W) this.drawView(ov, Math.max(x, 0.001))
    } else {
      this.drawView(this.mode !== 'original' && ov ? ov : img)
    }

    if (this.markersVisible) {
      const k = this.s * dpr
      for (const m of this.markers) {
        const x = (m.x - this.vx) * k
        const y = (m.y - this.vy) * k
        if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue
        this.drawMarker(m, x, y, Math.max(m.r * k, 4 * dpr), dpr)
      }
    }
    // Over the markers, so the grip is never hidden under a point.
    if (this.mode === 'split' && ov) this.drawSplit(Math.round(W * this.splitAt), H, dpr)
    if (this.down && this.down.drawR > 0) {
      // The point being drawn.
      const k = this.s * dpr
      c.save()
      c.setLineDash([5 * dpr, 4 * dpr])
      c.lineWidth = 1.5 * dpr
      c.strokeStyle = 'rgba(0,0,0,0.7)'
      c.beginPath()
      c.arc((this.down.ix - this.vx) * k, (this.down.iy - this.vy) * k, this.down.drawR * k + dpr, 0, Math.PI * 2)
      c.stroke()
      c.strokeStyle = '#fff'
      c.beginPath()
      c.arc((this.down.ix - this.vx) * k, (this.down.iy - this.vy) * k, this.down.drawR * k, 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }

    if (this.hover) {
      // In split view, read whichever half the cursor is over.
      const split = this.mode === 'split' && this.overlay
      const cursorX = (this.hover.x - this.vx) * this.s * dpr
      const src = split && cursorX < W * this.splitAt ? this.image : shown
      if (this.s < LOUPE_MAX_SCALE) this.drawLoupe(src, dpr)
      else this.drawReadout(src, dpr)
    }
  }

  /** The split divider at canvas x, with a grip halfway down: ◂ ▸ in a circle. */
  private drawSplit(x: number, H: number, dpr: number): void {
    const c = this.ctx
    const y = H / 2
    const r = 9 * dpr
    const gx = Math.min(Math.max(x, r + dpr), this.canvas.width - r - dpr)
    c.save()
    c.fillStyle = 'rgba(255,255,255,0.85)'
    c.fillRect(x - dpr / 2, 0, dpr, H)
    c.beginPath()
    c.arc(gx, y, r, 0, Math.PI * 2)
    c.fillStyle = this.splitDrag ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.55)'
    c.fill()
    c.lineWidth = 1.5 * dpr
    c.strokeStyle = 'rgba(255,255,255,0.9)'
    c.stroke()
    c.fillStyle = '#fff'
    for (const d of [-1, 1]) {
      c.beginPath()
      c.moveTo(gx + d * 6 * dpr, y)
      c.lineTo(gx + d * 2 * dpr, y - 3.5 * dpr)
      c.lineTo(gx + d * 2 * dpr, y + 3.5 * dpr)
      c.closePath()
      c.fill()
    }
    c.restore()
  }

  private drawMarker(m: Marker, x: number, y: number, r: number, dpr: number): void {
    const c = this.ctx
    c.save()
    if (m.off) c.globalAlpha = 0.35
    c.lineWidth = (m.selected ? 2.5 : 1.5) * dpr
    c.setLineDash(m.pending ? [4 * dpr, 3 * dpr] : m.auto ? [2 * dpr, 2 * dpr] : [])
    c.strokeStyle = 'rgba(0,0,0,0.7)'
    c.beginPath()
    c.arc(x, y, r + dpr, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = m.ignored ? '#888' : m.colour
    c.beginPath()
    c.arc(x, y, r, 0, Math.PI * 2)
    c.stroke()
    c.setLineDash([])
    c.fillStyle = m.ignored ? '#888' : m.colour
    c.beginPath()
    c.arc(x, y, 1.5 * dpr, 0, Math.PI * 2)
    c.fill()
    const fs = 11 * dpr
    c.font = `600 ${fs}px system-ui, sans-serif`
    const label = m.auto ? `${m.label}A` : m.label
    const tx = x + r + 3 * dpr
    const ty = y - r - 1 * dpr
    const tw = c.measureText(label).width
    c.fillStyle = 'rgba(0,0,0,0.65)'
    c.fillRect(tx - 2 * dpr, ty - fs, tw + 4 * dpr, fs + 3 * dpr)
    c.fillStyle = m.ignored ? '#aaa' : m.colour
    c.fillText(label, tx, ty)
    c.restore()
  }

  private drawLoupe(src: CanvasImageSource, dpr: number): void {
    if (!this.hover) return
    const c = this.ctx
    const size = LOUPE_PX * dpr
    const W = this.canvas.width
    // Sit in the corner away from the cursor.
    const cursorX = (this.hover.x - this.vx) * this.s * dpr
    const lx = cursorX > W / 2 ? 6 * dpr : W - size - 6 * dpr
    const ly = 6 * dpr
    const span = LOUPE_PX / LOUPE_ZOOM // image px visible across the loupe
    const sx = ((src as HTMLCanvasElement).width || this.imgW) / this.imgW // overlay may be a downscaled copy
    c.save()
    c.beginPath()
    c.rect(lx, ly, size, size)
    c.clip()
    c.imageSmoothingEnabled = false
    c.drawImage(src, (this.hover.x - span / 2) * sx, (this.hover.y - span / 2) * sx, span * sx, span * sx, lx, ly, size, size)
    const cx = lx + size / 2
    const cy = ly + size / 2
    c.strokeStyle = 'rgba(255,255,255,0.9)'
    c.lineWidth = dpr
    c.beginPath()
    c.arc(cx, cy, (this.down?.drawR || this.radius) * (size / span), 0, Math.PI * 2)
    c.stroke()
    c.beginPath()
    c.moveTo(cx - 6 * dpr, cy)
    c.lineTo(cx + 6 * dpr, cy)
    c.moveTo(cx, cy - 6 * dpr)
    c.lineTo(cx, cy + 6 * dpr)
    c.stroke()
    this.readoutStrip(src, sx, lx, ly + size, size, dpr)
    c.restore()
    c.strokeStyle = 'rgba(0,0,0,0.8)'
    c.lineWidth = 2 * dpr
    c.strokeRect(lx, ly, size, size)
    c.strokeStyle = 'rgba(255,255,255,0.18)'
    c.lineWidth = dpr
    c.strokeRect(lx + dpr, ly + dpr, size - 2 * dpr, size - 2 * dpr)
  }

  /** Zoomed in, the canvas is its own loupe: just show the pixel value. */
  private drawReadout(src: CanvasImageSource, dpr: number): void {
    const sx = ((src as HTMLCanvasElement).width || this.imgW) / this.imgW
    const w = 112 * dpr
    const cursorX = (this.hover!.x - this.vx) * this.s * dpr
    const lx = cursorX > this.canvas.width / 2 ? 6 * dpr : this.canvas.width - w - 6 * dpr
    this.readoutStrip(src, sx, lx, 6 * dpr + 17 * dpr, w, dpr)
  }

  /** RGB of the pixel under the cursor, in a strip whose bottom edge is at `bottom`. */
  private readoutStrip(src: CanvasImageSource, sx: number, lx: number, bottom: number, width: number, dpr: number): void {
    const px = readPixel(src, this.hover!.x * sx, this.hover!.y * sx)
    if (!px) return
    const c = this.ctx
    const h = 17 * dpr
    c.fillStyle = 'rgba(0,0,0,0.72)'
    c.fillRect(lx, bottom - h, width, h)
    c.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`
    c.fillRect(lx + 5 * dpr, bottom - h + 4 * dpr, 9 * dpr, 9 * dpr)
    c.fillStyle = '#e8e8e8'
    c.font = `${10 * dpr}px Consolas, monospace`
    c.textBaseline = 'middle'
    c.fillText(`${px[0]}  ${px[1]}  ${px[2]}`, lx + 19 * dpr, bottom - h / 2)
  }
}

function readPixel(src: CanvasImageSource, x: number, y: number): [number, number, number] | null {
  if (!(src instanceof HTMLCanvasElement)) return null
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  if (xi < 0 || yi < 0 || xi >= src.width || yi >= src.height) return null
  const d = src.getContext('2d', { willReadFrequently: true })?.getImageData(xi, yi, 1, 1).data
  return d ? [d[0], d[1], d[2]] : null
}
