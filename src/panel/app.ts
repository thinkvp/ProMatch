/**
 * Panel controller: owns the state (two frames, the point pairs, the match
 * options), re-fits the match whenever any of it changes, and drives the
 * views. All colour maths lives in core/.
 */
import { type Analysis, analyse } from '../core/analysis.ts'
import { suggestPairs } from '../core/auto.ts'
import { type Vec3, toHex } from '../core/color.ts'
import { matchFeatures } from '../core/features.ts'
import { findPlanes } from '../core/homography.ts'
import { convexHull, insidePolygon, lumaStats, pixelIndices, strideFor, vectorscope } from '../core/scopes.ts'
import { suggestFromMatches } from '../core/geo-auto.ts'
import { applyLutToPixels, bakeLut, toCube } from '../core/lut.ts'
import {
  DEFAULT_OPTIONS,
  type MatchModel,
  type MatchOptions,
  type PairInput,
  type PairReport,
  applyModel,
  fitMatch,
  identityModel,
  reportPairs,
  crossValidate,
  disagreeing,
} from '../core/match.ts'
import { type RgbaImage, sampleDisc } from '../core/sample.ts'
import { FrameView, type Marker, type ViewMode } from './frame-view.ts'
import * as host from './host.ts'
import { clearErrorBadge, log } from './log.ts'
import * as node from './node.ts'
import { loadOpenCv } from './opencv.ts'
import { ScopesView } from './scopes-view.ts'

type Role = 'source' | 'target'
const ROLES: Role[] = ['source', 'target']

interface Pt {
  x: number
  y: number
  /** Sample radius in frame px before the Sample size scaling; absent = the frame's default. */
  r?: number
}

interface Pair {
  id: number
  source: Pt | null
  target: Pt | null
  /** Suggested by Auto and not yet touched by hand. */
  auto?: boolean
  /** Switched off: left out of the fit, but still measured against it. */
  off?: boolean
}

type ShowMode = 'both' | 'source' | 'target'
type ScopeArea = 'frame' | 'matched' | 'point'

/** Areas feature matching found in both frames, as hulls in full-res pixels. */
interface MatchedAreas {
  key: string
  source: Array<Array<[number, number]>>
  target: Array<Array<[number, number]>>
}

/** A pair's report plus its tested (held-out) error — see crossValidate. */
type RowReport = PairReport & {
  /** Error here when the match is fitted without this pair; null with < 3 pairs. */
  tested: number | null
  /** The other pairs disagree with this one (see disagreeing). */
  disagrees: boolean
}

interface Frame {
  label: string
  path: string | null
  width: number
  height: number
  pixels: RgbaImage
  full: HTMLCanvasElement
  /** Downscaled copy the live preview is computed on. */
  small: ImageData
  /** Built on first use by Auto. */
  analysis?: Analysis
}

interface Session {
  version: 1
  frames: Partial<Record<Role, { path: string; label: string }>>
  pairs: Pair[]
  nextId: number
  opts: MatchOptions
  /** Sample size slider, % (−75…+200). */
  radiusScale?: number
  /** Legacy (sessions before per-point sizes): one radius for every point, px. */
  radius?: number
  lutSize: number
  lutName: string
  lutNameAuto: boolean
}

type NumericOption = 'exposureOffset' | 'localStrength' | 'colourRange' | 'shadeSpread' | 'smoothing'

interface SliderSpec {
  key: NumericOption | 'radiusScale'
  /** 'advanced' sliders live under the collapsed Fine-tune section. */
  group: 'main' | 'advanced'
  label: string
  help: string
  min: number
  max: number
  step: number
  fmt: (v: number) => string
}

const pct = (v: number) => `${Math.round(v * 100)}%`

const SLIDERS: SliderSpec[] = [
  { key: 'exposureOffset', group: 'main', label: 'Exposure nudge', help: 'Manual brightness change on top of the match.', min: -2, max: 2, step: 0.05, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} st` },
  { key: 'localStrength', group: 'main', label: 'Per-colour fix', help: 'How much of the point-specific correction to apply after the global match. 0 = global only.', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'radiusScale', group: 'main', label: 'Sample size', help: "Grows or shrinks every point's circle together, keeping their relative sizes. To size one point: drag on a frame to draw it, or drag its edge.", min: -75, max: 200, step: 5, fmt: (v) => `${v > 0 ? '+' : ''}${v}%` },
  { key: 'colourRange', group: 'advanced', label: 'Colour range', help: 'How far around each sampled colour its fix reaches. Narrow = only that exact colour; wide = its whole hue family.', min: 0.04, max: 0.3, step: 0.005, fmt: (v) => v.toFixed(3) },
  { key: 'shadeSpread', group: 'advanced', label: 'Shade spread', help: 'How far a fix spreads into lighter and darker shades of the same colour (the shadowed side of the apple).', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'smoothing', group: 'advanced', label: 'Smoothing', help: 'Higher trades exactness at each point for a gentler, safer LUT. Raise it if the After view shows banding or odd colours.', min: 0.005, max: 0.3, step: 0.005, fmt: (v) => v.toFixed(3) },
]

const DEV_MODE_KEY = 'promatch.devMode'

/** ΔE bands used everywhere a match error is shown. */
function grade(de: number): 'good' | 'ok' | 'bad' {
  return de < 2 ? 'good' : de < 5 ? 'ok' : 'bad'
}

const MARKER_COLOURS = ['#ffd23f', '#3fd0ff', '#ff6bd6', '#7dff6b', '#ff9b3f', '#b28dff', '#ff4f5e', '#4fffc1']
const PREVIEW_MAX_W = 1280
const PREVIEW_LUT_SIZE = 33

function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel)
  if (!el) throw new Error(`missing element ${sel}`)
  return el as HTMLElement
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function copyText(text: string): void {
  const ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

export class App {
  private frames: Record<Role, Frame | null> = { source: null, target: null }
  private views!: Record<Role, FrameView>
  private pairs: Pair[] = []
  private nextId = 1
  private pendingId: number | null = null
  private selectedId: number | null = null
  private opts: MatchOptions = { ...DEFAULT_OPTIONS }
  /** Sample size slider, %: scales every point's radius. */
  private radiusScale = 0
  private lutSize = 33
  private lutName = 'ProMatch'
  private lutNameAuto = true
  private model: MatchModel = identityModel()
  private reports = new Map<number, RowReport>()
  private inputs = new Map<number, PairInput>()
  private preview = canvasOf(1, 1)
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private openRole: Role = 'source'
  private lastExport: string | null = null
  private restoring = false
  /** Snapshots of `pairs` before each change, for Ctrl+Z / Ctrl+Shift+Z. */
  private undoStack: Pair[][] = []
  private redoStack: Pair[][] = []
  /** A drag is one undo step, not one per mouse move. */
  private dragUndo: { id: number; role: Role } | null = null
  private show: ShowMode = 'both'
  private scopes!: ScopesView
  private scopesOn = false
  private scopeArea: ScopeArea = 'frame'
  /** Also draw the target as shot (grey) on the scopes. */
  private scopeOriginal = false
  /** Matched-area hulls for the current frame pair; 'pending' while OpenCV works. */
  private areas: MatchedAreas | 'pending' | 'failed' | null = null
  /** The matched target preview's pixels (same size as Frame.small). */
  private previewData: ImageData | null = null
  private markersVisible = true

  async init(): Promise<void> {
    this.views = {
      source: this.makeView('source'),
      target: this.makeView('target'),
    }
    this.scopes = new ScopesView($('#vscope') as HTMLCanvasElement, $('#lscope') as HTMLCanvasElement, $('#scope-readout'))
    this.bindControls()
    this.bindKeys()
    this.applyLayout()
    await this.connectHost()
    await this.restore()
    this.update()
  }

  // -------------------------------------------------------------- setup

  private frameEl(role: Role): HTMLElement {
    return $(`.frame[data-role="${role}"]`)
  }

  private makeView(role: Role): FrameView {
    const el = this.frameEl(role)
    const view = new FrameView($('.canvas-wrap', el), $('canvas', el) as HTMLCanvasElement, {
      pick: (x, y, r) => this.onPick(role, x, y, r),
      move: (id, x, y) => {
        const p = this.pairs.find((q) => q.id === id)
        if (!p) return
        if (this.dragUndo?.id !== id || this.dragUndo.role !== role) {
          this.remember()
          this.dragUndo = { id, role }
        }
        p[role] = { ...p[role], x, y }
        p.auto = false // moved by hand: it is the user's point now
        this.scheduleUpdate()
      },
      resize: (id, r) => {
        const p = this.pairs.find((q) => q.id === id)
        const pt = p?.[role]
        if (!p || !pt) return
        if (this.dragUndo?.id !== id || this.dragUndo.role !== role) {
          this.remember()
          this.dragUndo = { id, role }
        }
        // Stored before the slider's scaling, so the slider keeps working on it.
        p[role] = { ...pt, r: r / this.sizeFactor }
        p.auto = false
        this.scheduleUpdate()
      },
      select: (id) => {
        // Pressing on a point starts a new drag: its moves/resizes are one fresh undo step.
        this.dragUndo = null
        this.selectedId = id
        this.renderMarkers()
        this.renderPoints()
        if (this.scopeArea === 'point') this.renderScopes()
      },
      remove: (id) => this.removePair(id),
    })
    for (const b of el.querySelectorAll('[data-capture]')) b.addEventListener('click', () => this.capture(role))
    for (const b of el.querySelectorAll('[data-open]')) {
      b.addEventListener('click', () => {
        this.openRole = role
        const input = $('#file-input') as HTMLInputElement
        input.value = ''
        input.click()
      })
    }
    return view
  }

  private bindControls(): void {
    ;($('#file-input') as HTMLInputElement).addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (f) this.openFile(this.openRole, f).catch((err) => log(String(err.message || err), 'error'))
    })

    for (const b of document.querySelectorAll<HTMLButtonElement>('#view-mode button')) {
      b.addEventListener('click', () => this.setViewMode(b.dataset.mode as ViewMode))
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#show-mode button')) {
      b.addEventListener('click', () => this.setShow(b.dataset.show as ShowMode))
    }
    $('#toggle-markers').addEventListener('click', () => this.setMarkersVisible(!this.markersVisible))
    $('#toggle-scopes').addEventListener('click', () => this.setScopes(!this.scopesOn))
    for (const b of document.querySelectorAll<HTMLButtonElement>('#scope-area button')) {
      b.addEventListener('click', () => {
        this.scopeArea = b.dataset.area as ScopeArea
        for (const o of document.querySelectorAll<HTMLButtonElement>('#scope-area button')) o.setAttribute('aria-pressed', String(o === b))
        this.renderScopes()
      })
    }
    const zoomScope = () => {
      this.scopes.zoom = this.scopes.zoom === 1 ? 2 : this.scopes.zoom === 2 ? 4 : 1
      $('#vscope-zoom').textContent = `${this.scopes.zoom}×`
      this.renderScopes()
    }
    $('#vscope-zoom').addEventListener('click', zoomScope)
    const orig = $('#scope-original') as HTMLInputElement
    orig.addEventListener('change', () => {
      this.scopeOriginal = orig.checked
      $('#lg-orig-wrap').hidden = !orig.checked
      this.renderScopes()
    })
    $('#vscope').addEventListener('click', zoomScope)
    $('#auto-points').addEventListener('click', () => this.runAuto())
    $('#clear-auto').addEventListener('click', () => {
      this.remember()
      this.pairs = this.pairs.filter((p) => !p.auto)
      this.pendingId = null
      this.scheduleUpdate()
    })
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [role="tab"]')) {
      b.addEventListener('click', () => this.selectTab(b.dataset.tab!))
    }

    const model = $('#opt-model') as HTMLSelectElement
    model.addEventListener('change', () => {
      this.opts.globalModel = model.value as MatchOptions['globalModel']
      this.scheduleUpdate()
    })
    const autoExp = $('#opt-autoexp') as HTMLInputElement
    autoExp.addEventListener('change', () => {
      this.opts.autoExposure = autoExp.checked
      this.scheduleUpdate()
    })
    const contrast = $('#opt-contrast') as HTMLInputElement
    contrast.addEventListener('change', () => {
      this.opts.matchContrast = contrast.checked
      this.labelModels()
      this.scheduleUpdate()
    })
    const roll = $('#opt-rolloff') as HTMLInputElement
    roll.addEventListener('change', () => {
      this.opts.highlightRolloff = roll.checked
      this.scheduleUpdate()
    })

    for (const s of SLIDERS) {
      const row = document.createElement('label')
      row.className = 'slider'
      row.title = s.help
      row.innerHTML =
        `<span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" data-key="${s.key}">` +
        `<output></output><button type="button" class="reset" title="Reset to default (or double-click the slider)">↺</button>`
      const input = $('input', row) as HTMLInputElement
      const reset = () => {
        input.value = String(this.sliderDefault(s))
        input.dispatchEvent(new Event('input'))
      }
      input.addEventListener('input', () => {
        const v = parseFloat(input.value)
        this.paintSlider(s, row, v)
        if (s.key === 'radiusScale') {
          this.radiusScale = v
          this.syncViewRadius()
        } else {
          this.opts[s.key] = v
        }
        this.scheduleUpdate()
      })
      input.addEventListener('dblclick', reset)
      $('.reset', row).addEventListener('click', (e) => {
        e.preventDefault()
        reset()
      })
      $(s.group === 'main' ? '#sliders' : '#sliders-advanced').appendChild(row)
    }

    const name = $('#lut-name') as HTMLInputElement
    name.addEventListener('input', () => {
      this.lutName = name.value
      this.lutNameAuto = false
      this.scheduleSave()
    })
    const size = $('#lut-size') as HTMLSelectElement
    size.addEventListener('change', () => {
      this.lutSize = parseInt(size.value, 10)
      this.scheduleSave()
    })

    $('#clear-points').addEventListener('click', () => {
      this.remember()
      const n = this.pairs.length
      log(`Cleared ${n} point(s). Ctrl+Z or Undo brings them back.`)
      this.pairs = []
      this.pendingId = null
      this.selectedId = null
      this.scheduleUpdate()
    })
    $('#export').addEventListener('click', () => this.exportLut())
    $('#undo').addEventListener('click', () => this.undo())
    $('#redo').addEventListener('click', () => this.redo())
    $('#add-lumetri').addEventListener('click', () => this.addLumetri())
    $('#spike-dump').addEventListener('click', () => this.spikeDump())
    $('#spike-setlut').addEventListener('click', () => this.spikeSetLut())

    $('#log-toggle').addEventListener('click', () => this.showLog($('#log').hidden))

    for (const li of document.querySelectorAll<HTMLElement>('#progress li')) {
      li.addEventListener('click', () => {
        const step = li.dataset.step!
        if (step === 'source' || step === 'target') this.setShow(this.show === 'both' ? 'both' : step)
        else if (step === 'points') this.selectTab('points')
        else ($('#export') as HTMLButtonElement).focus()
      })
    }

    let dev = false
    try {
      dev = localStorage.getItem(DEV_MODE_KEY) === '1'
    } catch {
      // Storage can be unavailable; dev mode just starts off.
    }
    document.body.classList.toggle('dev-mode', dev)

    window.addEventListener('resize', () => this.applyLayout())
  }

  private sliderDefault(s: SliderSpec): number {
    return s.key === 'radiusScale' ? 0 : DEFAULT_OPTIONS[s.key]
  }

  /** A frame's default sample radius: about 1/190 of its width (10 px at 1920). */
  private baseRadius(role: Role): number {
    const f = this.frames[role]
    return f ? Math.max(4, Math.round(f.width / 190)) : 10
  }

  private get sizeFactor(): number {
    return Math.max(0.05, 1 + this.radiusScale / 100)
  }

  /** The radius a point is actually sampled with (frame px). */
  private radiusOf(role: Role, pt: Pt): number {
    return Math.max(1.5, (pt.r ?? this.baseRadius(role)) * this.sizeFactor)
  }

  /** What a plain click would place, shown in each frame's loupe. */
  private syncViewRadius(): void {
    for (const role of ROLES) this.views[role].radius = this.baseRadius(role) * this.sizeFactor
  }

  /** Value label, filled track and the reset button's visibility. */
  private paintSlider(s: SliderSpec, row: HTMLElement, v: number): void {
    $('output', row).textContent = s.fmt(v)
    const input = $('input', row) as HTMLInputElement
    input.style.setProperty('--fill', `${((v - s.min) / (s.max - s.min)) * 100}%`)
    row.classList.toggle('changed', Math.abs(v - this.sliderDefault(s)) > s.step / 2)
  }

  private showLog(open: boolean): void {
    $('#log').hidden = !open
    $('#log-toggle').setAttribute('aria-expanded', String(open))
    if (open) clearErrorBadge()
  }

  /**
   * The first model is "exposure and contrast" only while contrast matching
   * is on; say exactly what it does. The others read as additions to it.
   */
  private labelModels(): void {
    const base = this.opts.matchContrast ? 'Exposure & contrast only' : 'Exposure only'
    $('#opt-model-base').textContent = base
    $('#model-base-name').textContent = base
  }

  /** Push current state into the form controls (after restore). */
  private syncControls(): void {
    ;($('#opt-model') as HTMLSelectElement).value = this.opts.globalModel
    ;($('#opt-autoexp') as HTMLInputElement).checked = this.opts.autoExposure
    ;($('#opt-contrast') as HTMLInputElement).checked = this.opts.matchContrast
    this.labelModels()
    ;($('#opt-rolloff') as HTMLInputElement).checked = this.opts.highlightRolloff
    for (const s of SLIDERS) {
      const input = $(`.slider input[data-key="${s.key}"]`) as HTMLInputElement
      const v = s.key === 'radiusScale' ? this.radiusScale : this.opts[s.key]
      input.value = String(v)
      this.paintSlider(s, input.parentElement!, v)
    }
    this.syncViewRadius()
    ;($('#lut-name') as HTMLInputElement).value = this.lutName
    ;($('#lut-size') as HTMLSelectElement).value = String(this.lutSize)
  }

  private bindKeys(): void {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        const on = document.body.classList.toggle('dev-mode')
        try {
          localStorage.setItem(DEV_MODE_KEY, on ? '1' : '0')
        } catch {
          // Not persisted; fine for a developer toggle.
        }
        if (on) ($('#dev-card') as HTMLDetailsElement).open = true
        e.preventDefault()
        return
      }
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.ctrlKey && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        if (e.key.toLowerCase() === 'y' || e.shiftKey) this.redo()
        else this.undo()
        e.preventDefault()
        return
      }
      if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this.setScopes(!this.scopesOn)
        return
      }
      if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this.setMarkersVisible(!this.markersVisible)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId !== null) {
        this.removePair(this.selectedId)
        e.preventDefault()
      } else if (e.key === 'Escape' && this.pendingId !== null) {
        this.removePair(this.pendingId)
      }
    })
  }

  private async connectHost(): Promise<void> {
    const status = $('#status')
    const disable = (why: string) => {
      for (const b of document.querySelectorAll<HTMLButtonElement>('[data-needs-host], [data-capture]')) {
        b.disabled = true
        b.title = why
      }
    }
    if (!host.available) {
      status.textContent = 'Browser preview'
      status.title = 'Not running inside Premiere: Open… loads stills, Export LUT downloads the file.'
      status.className = 'status warn'
      disable('Only available inside Premiere Pro')
      log('Running outside Premiere: use Open… to load stills; Export LUT downloads the file.', 'warn')
      return
    }
    try {
      const info = await host.connect()
      status.textContent = `${info.app} ${info.version}`
      status.title = `Connected to ${info.app} ${info.version}${info.sequence ? ` — sequence "${info.sequence}"` : ''}`
      status.className = 'status ok'
      log(`Connected to ${info.app} ${info.version}${info.sequence ? ` — sequence "${info.sequence}"` : ''}`)
    } catch (e) {
      status.textContent = 'Host script failed'
      status.title = 'jsx/host.jsx did not load — open the Log'
      status.className = 'status err'
      disable('host.jsx did not load — see Log')
      log(`host.jsx: ${(e as Error).message}`, 'error')
    }
  }

  // -------------------------------------------------------------- frames

  private async loadImage(role: Role, url: string, label: string, path: string | null): Promise<void> {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error(`Could not decode image for ${role}`))
      i.src = url
    })
    const w = img.naturalWidth
    const h = img.naturalHeight
    const full = canvasOf(w, h)
    const fctx = full.getContext('2d', { willReadFrequently: true })!
    fctx.drawImage(img, 0, 0)
    const pixels = fctx.getImageData(0, 0, w, h)
    const sw = Math.min(w, PREVIEW_MAX_W)
    const sh = Math.max(1, Math.round((h * sw) / w))
    const small = canvasOf(sw, sh)
    const sctx = small.getContext('2d', { willReadFrequently: true })!
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(img, 0, 0, sw, sh)

    const prev = this.frames[role]
    this.frames[role] = { label, path, width: w, height: h, pixels, full, small: sctx.getImageData(0, 0, sw, sh) }
    if (prev && (prev.width !== w || prev.height !== h)) {
      // Different frame size: rescale this side's points so they stay on the same features.
      for (const p of this.pairs) {
        const q = p[role]
        if (q) p[role] = { x: (q.x * w) / prev.width, y: (q.y * h) / prev.height, r: q.r === undefined ? undefined : (q.r * w) / prev.width }
      }
    }
    this.views[role].setImage(full, w, h)
    this.syncViewRadius()
    this.applyLayout() // the frame's aspect ratio decides side-by-side vs stacked
    const el = this.frameEl(role)
    el.classList.add('loaded')
    this.areas = null
    $('[data-meta]', el).textContent = label
    $('[data-meta]', el).title = path ?? label
    $('[data-empty]', el).hidden = true
    this.scheduleUpdate()
  }

  private async capture(role: Role): Promise<void> {
    try {
      const base = node.join(node.capturesDir(), `${role}-${Date.now()}`)
      log(`Capturing ${role} frame…`)
      const info = await host.captureFrame(base)
      const file = await node.waitForFile([`${base}.png`, base])
      const who = info.clip ? info.clip.name : info.sequence
      const label = `${who} @ ${info.timecode}${info.clip?.multicam ? ' (multicam)' : ''}`
      await this.loadImage(role, node.readDataUrl(file), label, file)
      if (role === 'target' && info.clip) this.autoName(info.clip.name)
      log(`${role}: ${label}`)
    } catch (e) {
      log(`Capture failed: ${(e as Error).message}`, 'error')
    }
  }

  async openFile(role: Role, f: File): Promise<void> {
    let path: string | null = null
    if (node.hasNode) {
      // Keep a copy so the session can be restored after a panel reload.
      const ext = (f.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase()
      path = node.join(node.capturesDir(), `${role}-${Date.now()}${ext}`)
      node.writeBytes(path, await f.arrayBuffer())
    }
    await this.loadImage(role, URL.createObjectURL(f), f.name, path)
    if (role === 'target') this.autoName(f.name.replace(/\.[^.]+$/, ''))
  }

  private autoName(targetName: string): void {
    if (!this.lutNameAuto) return
    this.lutName = `ProMatch - ${targetName}`
    ;($('#lut-name') as HTMLInputElement).value = this.lutName
  }

  /**
   * Narrow panels scroll, so frames get an explicit share of the window
   * height (the viewer is pinned, and the controls need the rest). Wide
   * panels ignore this: CSS gives the frames the viewer column's full height.
   */
  private applyLayout(): void {
    const frames = $('.frames')
    const share = this.show === 'both' ? 0.25 : 0.5
    frames.style.setProperty('--frame-h', `${Math.max(140, Math.round(window.innerHeight * share))}px`)
    frames.dataset.arrange = window.innerWidth >= 900 && this.show === 'both' ? this.bestArrangement(frames) : ''
    for (const role of ROLES) this.views[role].layout()
  }

  /**
   * Wide layout with both frames: side by side or stacked, whichever gives
   * the bigger pictures in the space the viewer column has. A short, wide
   * panel wants side by side; a tall one wants them stacked.
   */
  private bestArrangement(frames: HTMLElement): 'side' | 'stack' {
    const f = this.frames.source ?? this.frames.target
    const aspect = f ? f.width / f.height : 16 / 9
    const el = this.frameEl('source')
    const wrap = $('.canvas-wrap', el)
    // Space a frame's own chrome (header, padding, border) takes around the canvas.
    const cw = el.offsetWidth - wrap.clientWidth
    const ch = el.offsetHeight - wrap.clientHeight
    const gap = 8
    const W = frames.clientWidth
    const H = frames.clientHeight
    const side = Math.min((W - gap) / 2 - cw, (H - ch) * aspect)
    const stack = Math.min(W - cw, ((H - gap) / 2 - ch) * aspect)
    return stack > side ? 'stack' : 'side'
  }

  private setShow(show: ShowMode): void {
    this.show = show
    $('.frames').dataset.show = show
    for (const b of document.querySelectorAll<HTMLButtonElement>('#show-mode button')) {
      b.setAttribute('aria-pressed', String(b.dataset.show === show))
    }
    this.applyLayout()
  }

  private setMarkersVisible(on: boolean): void {
    this.markersVisible = on
    $('#toggle-markers').setAttribute('aria-pressed', String(on))
    for (const role of ROLES) this.views[role].setMarkersVisible(on)
  }

  private selectTab(tab: string): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [role="tab"]')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab))
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.tab-panel')) panel.hidden = panel.dataset.panel !== tab
  }

  /**
   * Replace any previous Auto pairs with fresh suggestions; hand-placed
   * pairs are kept.
   *
   * First choice is geometric (geo-auto.ts): feature matching finds the same
   * physical spots in both frames, so every pair can be checked by eye. On a
   * real interview it scored ΔE 2.85 alone vs 4.35 for the colour method
   * (spikes/SPIKES.md). Plain scenes with too little texture to match, or an
   * OpenCV load failure, fall back to the colour method (auto.ts).
   */
  private async runAuto(): Promise<void> {
    const src = this.frames.source
    const tgt = this.frames.target
    if (!src || !tgt) {
      log('Auto needs both frames: capture the source and the target first.', 'warn')
      return
    }
    const btn = $('#auto-points') as HTMLButtonElement
    btn.classList.add('busy')
    btn.disabled = true
    // Let the busy state paint before the (sub-second) work blocks the thread.
    await new Promise((r) => setTimeout(r, 30))
    try {
      const t0 = performance.now()
      let sug: Array<{ source: Pt; target: Pt }> = []
      let how = ''
      try {
        const cv = await loadOpenCv()
        const matches = matchFeatures(cv, src.pixels, tgt.pixels)
        const geo = suggestFromMatches(matches, src.pixels, tgt.pixels)
        how = `matched ${matches.length} features into ${geo.planes.length} area(s)`
        if (geo.suggestions.length >= 3) sug = geo.suggestions
        else log(`Auto: only ${geo.suggestions.length} pair(s) from feature matching (${how}); using colour matching instead.`, 'warn')
      } catch (e) {
        log(`Auto: feature matching unavailable (${(e as Error).message}); using colour matching instead.`, 'warn')
      }
      if (!sug.length) {
        src.analysis ??= analyse(src.pixels)
        tgt.analysis ??= analyse(tgt.pixels)
        sug = suggestPairs(src.analysis, tgt.analysis)
        how = 'by colour (pairs may be on different objects)'
      }
      this.remember()
      this.pairs = this.pairs.filter((p) => !p.auto)
      for (const g of sug) this.pairs.push({ id: this.nextId++, source: g.source, target: g.target, auto: true })
      this.pendingId = null
      this.selectTab('points')
      log(`Auto suggested ${sug.length} pair(s) ${how}, in ${Math.round(performance.now() - t0)} ms.`)
      if (!sug.length) log('Auto found nothing the two frames clearly share. Place points by hand.', 'warn')
      this.update()
    } catch (e) {
      log(`Auto failed: ${(e as Error).message}`, 'error')
    } finally {
      btn.classList.remove('busy')
      btn.disabled = false
    }
  }

  private setScopes(on: boolean): void {
    this.scopesOn = on
    $('#scopes').hidden = !on
    $('#toggle-scopes').setAttribute('aria-pressed', String(on))
    this.applyLayout()
    this.renderScopes()
  }

  /**
   * Source vs MATCHED target on the scopes, over the chosen area, plus the
   * target as shot when "Original" is on. Deliberately independent of the
   * image's Before / Split / After view, so the key always describes what is
   * drawn.
   */
  private renderScopes(): void {
    if (!this.scopesOn) return
    const src = this.frames.source
    const tgt = this.frames.target
    if (!src || !tgt) {
      this.scopes.clear('Capture both frames to compare them.')
      return
    }
    // The matched preview is rebuilt on every update; it can lag a frame
    // behind a freshly loaded target, in which case wait for the next one.
    const tPx = this.previewData
    if (!tPx || tPx.width !== tgt.small.width || tPx.height !== tgt.small.height) {
      this.scopes.clear('Preparing the matched target…')
      return
    }
    const oPx = tgt.small
    const sPx = src.small
    const ks = sPx.width / src.width
    const kt = tPx.width / tgt.width
    let sKeep: ((x: number, y: number) => boolean) | undefined
    let tKeep: ((x: number, y: number) => boolean) | undefined
    let note = ''
    if (this.scopeArea === 'matched') {
      const areas = this.matchedAreas(src, tgt)
      if (areas === 'pending') {
        this.scopes.clear('Finding matched areas…')
        return
      }
      if (!areas) note = 'No matched areas found — whole frame shown.'
      else {
        const sh = areas.source.map((h) => h.map(([x, y]) => [x * ks, y * ks] as [number, number]))
        const th = areas.target.map((h) => h.map(([x, y]) => [x * kt, y * kt] as [number, number]))
        sKeep = (x, y) => sh.some((h) => insidePolygon(h, x, y))
        tKeep = (x, y) => th.some((h) => insidePolygon(h, x, y))
      }
    } else if (this.scopeArea === 'point') {
      const p = this.pairs.find((q) => q.id === this.selectedId && q.source && q.target) ?? this.pairs.find((q) => q.source && q.target)
      if (!p) {
        this.scopes.clear('Select a point to scope just its circles.')
        return
      }
      const disc = (pt: Pt, r: number, k: number) => {
        const cx = pt.x * k
        const cy = pt.y * k
        const rr = Math.max(4, r * k)
        return (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr
      }
      sKeep = disc(p.source!, this.radiusOf('source', p.source!), ks)
      tKeep = disc(p.target!, this.radiusOf('target', p.target!), kt)
    }
    // Small areas: sample every pixel; whole frames: ~60k of them.
    const sStep = this.scopeArea === 'point' ? 1 : strideFor(sPx.width, sPx.height)
    const tStep = this.scopeArea === 'point' ? 1 : strideFor(tPx.width, tPx.height)
    const si = pixelIndices(sPx.width, sPx.height, sStep, sKeep)
    // Same pixels for matched and original: the preview is the original, matched.
    const ti = pixelIndices(tPx.width, tPx.height, tStep, tKeep)
    if (!si.length || !ti.length) {
      this.scopes.clear('Nothing to show for this area.')
      return
    }
    const size = this.scopes.vectorSize()
    this.scopes.render(
      { vector: vectorscope(sPx.data, si, size, this.scopes.zoom), luma: lumaStats(sPx.data, si) },
      { vector: vectorscope(tPx.data, ti, size, this.scopes.zoom), luma: lumaStats(tPx.data, ti) },
      this.scopeOriginal ? { vector: vectorscope(oPx.data, ti, size, this.scopes.zoom), luma: lumaStats(oPx.data, ti) } : null,
    )
    if (note) $('#scope-readout').insertAdjacentHTML('beforeend', `<p class="scope-empty">${note}</p>`)
  }

  /**
   * Hulls of the planes feature matching finds in both frames (face,
   * picture, shirt…). Computed once per frame pair, on first use; until then
   * returns 'pending' and re-renders the scopes when done.
   */
  private matchedAreas(src: Frame, tgt: Frame): MatchedAreas | 'pending' | null {
    const key = `${src.label}|${src.width}|${tgt.label}|${tgt.width}`
    if (this.areas && this.areas !== 'pending' && this.areas !== 'failed' && this.areas.key === key) return this.areas
    if (this.areas === 'pending') return 'pending'
    if (this.areas === 'failed') return null
    this.areas = 'pending'
    ;(async () => {
      try {
        await new Promise((r) => setTimeout(r, 20)) // let "Finding…" paint
        const cv = await loadOpenCv()
        const planes = findPlanes(matchFeatures(cv, src.pixels, tgt.pixels), 0.004 * tgt.width)
        this.areas = planes.length
          ? {
              key,
              source: planes.map((pl) => convexHull(pl.members.map((m) => m.a))),
              target: planes.map((pl) => convexHull(pl.members.map((m) => m.b))),
            }
          : 'failed'
        if (!planes.length) log('Scopes: no matched areas found between the frames.', 'warn')
      } catch (e) {
        this.areas = 'failed'
        log(`Scopes: matched areas unavailable (${(e as Error).message}).`, 'warn')
      }
      this.renderScopes()
    })()
    return 'pending'
  }

  private setViewMode(mode: ViewMode): void {
    this.views.target.mode = mode
    for (const b of document.querySelectorAll<HTMLButtonElement>('#view-mode button')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
    }
    this.views.target.render()
  }

  // -------------------------------------------------------------- points

  private onPick(role: Role, x: number, y: number, drawnR?: number): void {
    this.remember()
    const other: Role = role === 'source' ? 'target' : 'source'
    // A drawn point keeps its size; stored before the slider's scaling.
    const pt: Pt = drawnR === undefined ? { x, y } : { x, y, r: drawnR / this.sizeFactor }
    const pending = this.pairs.find((p) => p.id === this.pendingId)
    if (pending) {
      pending[role] = pt
      // A second click on the same side re-places the half-made point;
      // a click on the other side completes it.
      if (pending[other]) this.pendingId = null
      this.selectedId = pending.id
    } else {
      const p: Pair = { id: this.nextId++, source: null, target: null }
      p[role] = pt
      this.pairs.push(p)
      this.pendingId = p.id
      this.selectedId = p.id
      // If the other frame is identical framing (same camera re-captured), the
      // user still has to click it — we never guess correspondences.
    }
    this.scheduleUpdate()
  }

  /** Call before changing `pairs`. Starting a new branch drops the redo history. */
  private remember(): void {
    this.undoStack.push(JSON.parse(JSON.stringify(this.pairs)))
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack = []
    this.dragUndo = null
  }

  private undo(): void {
    const prev = this.undoStack.pop()
    if (!prev) return
    this.redoStack.push(JSON.parse(JSON.stringify(this.pairs)))
    this.restorePairs(prev)
  }

  private redo(): void {
    const next = this.redoStack.pop()
    if (!next) return
    this.undoStack.push(JSON.parse(JSON.stringify(this.pairs)))
    this.restorePairs(next)
  }

  private restorePairs(pairs: Pair[]): void {
    this.pairs = pairs
    this.dragUndo = null
    if (!pairs.some((p) => p.id === this.pendingId)) this.pendingId = null
    if (!pairs.some((p) => p.id === this.selectedId)) this.selectedId = null
    // A pair that is half-made after undo is the one being placed.
    const half = pairs.find((p) => !p.source || !p.target)
    if (half) this.pendingId = half.id
    this.scheduleUpdate()
  }

  private removePair(id: number): void {
    this.remember()
    this.pairs = this.pairs.filter((p) => p.id !== id)
    if (this.pendingId === id) this.pendingId = null
    if (this.selectedId === id) this.selectedId = null
    this.scheduleUpdate()
  }

  private colourFor(id: number): string {
    const i = this.pairs.findIndex((p) => p.id === id)
    return MARKER_COLOURS[(i < 0 ? 0 : i) % MARKER_COLOURS.length]
  }

  // -------------------------------------------------------------- match

  private scheduleUpdate(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      this.update()
    }, 30)
  }

  private update(): void {
    const src = this.frames.source
    const tgt = this.frames.target
    this.inputs.clear()
    if (src && tgt) {
      for (const p of this.pairs) {
        if (!p.source || !p.target) continue
        this.inputs.set(p.id, {
          source: sampleDisc(src.pixels, p.source.x, p.source.y, this.radiusOf('source', p.source)),
          target: sampleDisc(tgt.pixels, p.target.x, p.target.y, this.radiusOf('target', p.target)),
        })
      }
    }
    const on = this.pairs.filter((p) => !p.off && this.inputs.has(p.id)).map((p) => p.id)
    const off = this.pairs.filter((p) => p.off && this.inputs.has(p.id)).map((p) => p.id)
    const inputs = on.map((id) => this.inputs.get(id)!)
    try {
      this.model = fitMatch(inputs, this.opts)
    } catch (e) {
      log(`Fit failed: ${(e as Error).message}`, 'error')
      this.model = identityModel()
    }
    this.reports.clear()
    let tested: number[] | null = null
    try {
      tested = crossValidate(inputs, this.opts)
    } catch {
      tested = null
    }
    const disagree = new Set(tested ? disagreeing(inputs, this.opts).map((i) => on[i]) : [])
    reportPairs(this.model, inputs).forEach((r, i) =>
      this.reports.set(on[i], { ...r, tested: tested ? tested[i] : null, disagrees: disagree.has(on[i]) }),
    )
    // Switched-off pairs are scored against a fit they took no part in —
    // exactly the "how good is the match there without it?" comparison.
    reportPairs({ ...this.model, ignored: [] }, off.map((id) => this.inputs.get(id)!)).forEach((r, i) =>
      this.reports.set(off[i], { ...r, used: false, reason: 'off', tested: r.after, disagrees: false }),
    )

    if (tgt) this.renderPreview(tgt)
    this.renderMarkers()
    this.renderPoints()
    this.renderSummary()
    this.renderHint()
    this.renderProgress()
    this.renderScopes()
    this.scheduleSave()
  }

  private renderPreview(tgt: Frame): void {
    const lut = bakeLut(PREVIEW_LUT_SIZE, (c) => applyModel(this.model, c))
    const img = new ImageData(new Uint8ClampedArray(tgt.small.data), tgt.small.width, tgt.small.height)
    applyLutToPixels(lut, img.data)
    this.previewData = img
    if (this.preview.width !== img.width || this.preview.height !== img.height) {
      this.preview = canvasOf(img.width, img.height)
    }
    this.preview.getContext('2d', { willReadFrequently: true })!.putImageData(img, 0, 0)
    this.views.target.setOverlay(this.preview)
  }

  // -------------------------------------------------------------- render

  private renderMarkers(): void {
    for (const role of ROLES) {
      const markers: Marker[] = []
      this.pairs.forEach((p, i) => {
        const pt = p[role]
        if (!pt) return
        const r = this.reports.get(p.id)
        markers.push({
          id: p.id,
          label: String(i + 1),
          x: pt.x,
          y: pt.y,
          r: this.radiusOf(role, pt),
          colour: this.colourFor(p.id),
          selected: p.id === this.selectedId,
          pending: p.id === this.pendingId,
          ignored: !!r && !r.used,
          auto: !!p.auto,
          off: !!p.off,
        })
      })
      this.views[role].setMarkers(markers)
    }
  }

  private renderPoints(): void {
    const list = $('#points')
    list.innerHTML = ''
    const complete = this.pairs.filter((p) => p.source && p.target).length
    const reps = [...this.reports.values()]
    const nOff = this.pairs.filter((p) => p.off).length
    const nIgnored = reps.filter((r) => !r.used && r.reason !== 'off').length
    const nCheck = reps.filter((r) => r.disagrees).length
    $('#point-count').innerHTML = this.pairs.length
      ? `${complete} pair${complete === 1 ? '' : 's'}` +
        (nOff ? ` · ${nOff} off` : '') +
        (nIgnored ? ` · ${nIgnored} ignored` : '') +
        (nCheck ? ` · <span class="tc-warn">${nCheck} to check</span>` : '')
      : ''
    $('#points-head').hidden = !this.reports.size
    ;($('#clear-points') as HTMLButtonElement).hidden = !this.pairs.length
    ;($('#clear-auto') as HTMLButtonElement).hidden = !this.pairs.some((p) => p.auto)
    ;($('#undo') as HTMLButtonElement).disabled = !this.undoStack.length
    ;($('#redo') as HTMLButtonElement).disabled = !this.redoStack.length
    if (!this.pairs.length) {
      list.innerHTML = '<li class="points-empty">No points yet. Click the same thing in both frames to add one.</li>'
      return
    }
    const rgb = (c: number[]) => c.map((v) => Math.round(v * 255)).join(', ')
    const sw = (c: Vec3, label: string) => `<span class="sw" style="background:${toHex(c)}" title="${label}: ${rgb(c)}"></span>`
    this.pairs.forEach((p, i) => {
      const li = document.createElement('li')
      li.className = 'point'
      if (p.id === this.selectedId) li.classList.add('selected')
      const r = this.reports.get(p.id)
      const inp = this.inputs.get(p.id)
      const who = p.auto ? 'Suggested by Auto' : 'Placed by hand'
      const dotTip = p.off ? `${who}. Off: left out of the match. Click to switch it back on.` : `${who}. Click to switch it off and compare the match without it.`
      const dot = `<button class="dot${p.auto ? ' auto' : ''}${p.off ? ' off' : ''}" style="--c:${this.colourFor(p.id)}" title="${dotTip}" aria-pressed="${!p.off}">${i + 1}</button>`
      let body: string
      if (!p.source || !p.target) {
        body = `<span class="wait">Now click the same spot on the ${p.source ? 'target' : 'source'}…</span>`
      } else if (!r || !inp) {
        body = '<span class="wait">Load both frames</span>'
      } else {
        if (r?.disagrees) li.classList.add('suspect')
        if (p.off) li.classList.add('off')
        else if (!r.used) li.classList.add('ignored')
        body =
          sw(inp.source.rgb, 'Source') +
          sw(inp.target.rgb, 'Target') +
          sw(r.matched, 'Target after match') +
          (r.used
            ? this.errorCell(r)
            : p.off
              ? `<span class="de" title="Off: not used in the match. This is how close the match gets here without it.">off · ${r.before.toFixed(1)} → <span class="pill muted">${r.after.toFixed(1)}</span></span>`
              : `<span class="de ignored" title="This pair is left out of the fit">Ignored: ${escapeHtml(r.reason ?? '')}</span>`)
      }
      li.innerHTML = `${dot}${body}<button class="x" title="Delete point (Del)">✕</button>`
      li.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('x')) {
          this.removePair(p.id)
          return
        }
        if ((e.target as HTMLElement).classList.contains('dot')) {
          this.remember()
          p.off = !p.off
          this.scheduleUpdate()
          return
        }
        this.selectedId = p.id
        this.renderMarkers()
        this.renderPoints()
        if (this.scopeArea === 'point') this.renderScopes()
      })
      list.appendChild(li)
    })
  }

  /** Before → tested error for a pair in the fit, flagged when the others disagree with it. */
  private errorCell(r: RowReport): string {
    const v = r.tested ?? r.after
    const tip = r.disagrees
      ? "The other points disagree with this one: the match can't get close here without it. Check it's the same surface in both frames, in focus in both (a soft background blurs neighbouring colours together), and not in shadow on one side. Click its number to switch it off and compare."
      : r.tested === null
        ? 'Before: how far apart the frames are here. After: the fitted error — add 3+ points to get a tested one.'
        : 'Before: how far apart the frames are here. After: how close the match gets here when fitted WITHOUT this point — an honest test. Under ~2 is hard to see.'
    return (
      `<span class="de" title="${tip}">${r.before.toFixed(1)} → ` +
      `<span class="pill ${r.disagrees ? 'bad' : grade(v)}">${r.disagrees ? '! ' : ''}${v.toFixed(1)}</span></span>`
    )
  }

  private renderSummary(): void {
    const m = this.model
    const el = $('#quality')
    const used = [...this.reports.values()].filter((r) => r.used)
    if (!m.used || !used.length) {
      el.hidden = true
      return
    }
    const before = used.reduce((a, r) => a + r.before, 0) / used.length
    const withTest = used.filter((r) => r.tested !== null)
    const isTested = withTest.length > 0
    const after = isTested ? withTest.reduce((a, r) => a + r.tested!, 0) / withTest.length : used.reduce((a, r) => a + r.after, 0) / used.length
    const st = m.exposureStops + this.opts.exposureOffset
    const g = m.balance
    const chips = [`Exposure ${st >= 0 ? '+' : '−'}${Math.abs(st).toFixed(2)} st`]
    // Always the same chips, so the list below never jumps when a point is toggled.
    if (this.opts.matchContrast) chips.push(`Contrast ×${m.contrast.toFixed(2)}`)
    if (this.opts.globalModel !== 'exposure') chips.push(`R ${g[0].toFixed(2)} · G ${g[1].toFixed(2)} · B ${g[2].toFixed(2)}`)
    el.innerHTML =
      `<div class="q-main" title="${
        isTested
          ? 'Tested error: each point is scored by a match fitted without it, then averaged (Oklab ΔE×100). Over-tuning cannot fake it: bending the match around each point makes this worse. Under ~2 is hard to see.'
          : 'Fitted error over the points. With fewer than 3 points there is nothing to test against, so this is optimistic.'
      }">` +
      `<span class="q-label">${isTested ? 'Tested error' : 'Fitted error'}</span><span class="q-before">${before.toFixed(1)}</span><span class="q-arrow">→</span>` +
      `<span class="q-after ${grade(after)}">${after.toFixed(1)}</span></div>` +
      `<div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}` +
      '</div>'
    el.hidden = false
  }

  /** Header steps: done / current / to do. */
  private renderProgress(): void {
    const done: Record<string, boolean> = {
      source: !!this.frames.source,
      target: !!this.frames.target,
      points: this.model.used > 0,
      export: !!this.lastExport,
    }
    let current = false
    for (const li of document.querySelectorAll<HTMLElement>('#progress li')) {
      const d = done[li.dataset.step!]
      li.classList.toggle('done', d)
      li.classList.toggle('current', !d && !current)
      if (!d) current = true
    }
  }

  private renderHint(): void {
    const el = $('#hint')
    const pending = this.pairs.find((p) => p.id === this.pendingId)
    const n = pending ? this.pairs.indexOf(pending) + 1 : 0
    let html: string
    if (!this.frames.source) html = '<span><b>Step 1.</b> Capture the <b>source</b>: the camera angle you want to match to.</span>'
    else if (!this.frames.target) html = '<span><b>Step 2.</b> Capture the <b>target</b>: the angle you want to fix.</span>'
    else if (pending && !pending.target) html = `<span>Now click the same spot on the <b>target</b> for point ${n}. <kbd>Esc</kbd> cancels.</span>`
    else if (pending && !pending.source) html = `<span>Now click the same spot on the <b>source</b> for point ${n}. <kbd>Esc</kbd> cancels.</span>`
    else if (!this.pairs.length)
      html = '<span><b>Step 3.</b> Press <b>Auto</b> for a starting set, or click something on the source and then the same thing on the target. Good picks: skin, a neutral wall, a strongly coloured object, dark clothing.</span>'
    else if (this.pairs.every((p) => p.auto))
      html = '<span>Auto pairs are dashed. Check them, delete any that look wrong, then add <b>two or three of your own</b> on skin. That beats either on its own.</span>'
    else if (!this.lastExport)
      html = '<span>Click to add a point, or drag out to draw a bigger one. Drag a point to move it, drag its edge to resize, right-click or <kbd>Del</kbd> to remove. <kbd>Space</kbd>+drag pans. When <b>After</b> looks right, <b>Export LUT</b>.</span>'
    else html = '<span>Exported. Keep refining and export again; the file is overwritten in place.</span>'
    el.innerHTML = html
  }

  // -------------------------------------------------------------- output

  private cubeText(): string {
    const lut = bakeLut(this.lutSize, (c) => applyModel(this.model, c))
    const m = this.model
    const comments = [
      'Generated by ProMatch',
      `Created ${new Date().toISOString()}`,
      `Source: ${this.frames.source?.label ?? '-'}`,
      `Target: ${this.frames.target?.label ?? '-'}`,
      `Pairs used: ${m.used}${m.ignored.length ? ` (${m.ignored.length} ignored)` : ''}`,
      `Exposure: ${(m.exposureStops + this.opts.exposureOffset).toFixed(3)} stops, contrast ${m.contrast.toFixed(3)}`,
      `Options: ${JSON.stringify(this.opts)}`,
    ]
    return toCube(lut, this.lutName, comments)
  }

  /** The open project's LUT folder (see node.lutDir). */
  private async lutFolder(): Promise<{ dir: string; withProject: boolean }> {
    let projectPath: string | null = null
    if (host.available) {
      try {
        projectPath = (await host.projectInfo()).path
      } catch (e) {
        log(`Could not read the project path: ${(e as Error).message}`, 'warn')
      }
    }
    return node.lutDir(projectPath)
  }

  private async exportLut(): Promise<void> {
    if (!this.model.used) {
      log('Nothing to export yet: add at least one complete point pair (source + target).', 'warn')
      this.showResult('<div class="er-title">Nothing to export yet</div><p class="small">Add at least one point on both frames.</p>', 'warn')
      return
    }
    const text = this.cubeText()
    const fileName = `${node.safeFileName(this.lutName)}.cube`
    if (!node.hasNode) {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
      a.download = fileName
      a.click()
      log(`Downloaded ${fileName}`)
      return
    }
    try {
      const folder = await this.lutFolder()
      const p = node.join(folder.dir, fileName)
      node.writeText(p, text)
      this.lastExport = p
      copyText(p)
      log(`Saved ${p} (${this.lutSize}³)${folder.withProject ? '' : ' — project not saved yet, so not beside it'}`)
      const where = folder.withProject
        ? 'Saved beside the project, so it moves and backs up with it.'
        : '<b>This project has never been saved</b>, so the LUT went to Documents. Save the project and export again to keep it with the project.'
      this.showResult(
        `<div class="er-title">Saved ${escapeHtml(fileName)}</div>` +
          `<p class="small"><code>${escapeHtml(p)}</code><br>${where} Path copied to the clipboard.</p>` +
          '<ol class="steps">' +
          "<li>Select the target camera's clip in the Timeline. No Lumetri yet? Press <b><i>fx</i></b> in the bar below.</li>" +
          '<li>Lumetri Color ▸ <b>Basic Correction</b> ▸ <b>Input LUT</b> ▸ <b>Browse…</b>, then paste the path.</li>' +
          "<li><b>Multicam:</b> apply it to the angle's clip inside the multicam <i>source</i> sequence, so every cut to that camera inherits it.</li>" +
          '</ol>' +
          '<div class="button-row"><button data-r="reveal">Show in Explorer</button><button data-r="copy">Copy path</button></div>',
        folder.withProject ? 'ok' : 'warn',
      )
      this.renderProgress()
      this.renderHint()
    } catch (e) {
      log(`Export failed: ${(e as Error).message}`, 'error')
    }
  }

  private showResult(html: string, tone: 'ok' | 'warn' = 'ok'): void {
    const box = $('#export-result')
    box.innerHTML = `${html}<button class="close" title="Dismiss">✕</button>`
    box.classList.toggle('warn', tone === 'warn')
    box.hidden = false
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    box.querySelector('.close')?.addEventListener('click', () => (box.hidden = true))
    box.querySelector('[data-r="reveal"]')?.addEventListener('click', () => this.lastExport && node.reveal(this.lastExport))
    box.querySelector('[data-r="copy"]')?.addEventListener('click', () => {
      if (this.lastExport) copyText(this.lastExport)
      log('Path copied')
    })
  }

  private async addLumetri(): Promise<void> {
    try {
      const r = await host.addLumetri()
      log(`Added Lumetri Color to ${r.added} clip(s)${r.failed.length ? `; could not reach: ${r.failed.join(', ')}` : ''}`)
    } catch (e) {
      log(`Add Lumetri: ${(e as Error).message}`, 'error')
    }
  }

  private async spikeDump(): Promise<void> {
    try {
      const d = await host.dumpEffects()
      // Full values go to a file (blob params can be long); the log gets the
      // LUT-related ones, which are what the set-LUT spike is about.
      let where = ''
      if (node.hasNode) {
        const file = node.join(node.ensureDir(node.join(node.dataDir(), 'spikes')), `dump-${node.safeFileName(d.clip)}-${Date.now()}.json`)
        node.writeText(file, JSON.stringify(d, null, 1))
        where = ` — full dump: ${file}`
      }
      const lines: string[] = []
      for (const c of d.components) {
        lines.push(`[${c.index}] ${c.name} (${c.matchName}), ${c.props.length} params`)
        for (const p of c.props) {
          if (!/LUT|Look|Asset|Blob/i.test(p.name)) continue
          const v = p.value.length > 160 ? `${p.value.slice(0, 160)}… (${p.length} chars)` : p.value
          lines.push(`    #${p.index} ${p.name} [${p.type}] = ${JSON.stringify(v)}${p.codes ? `  codes: ${p.codes}` : ''}`)
        }
      }
      log(`Effects on "${d.clip}"${where}\n${lines.join('\n')}`)
      this.showLog(true)
    } catch (e) {
      log(`Dump: ${(e as Error).message}`, 'error')
    }
  }

  private async spikeSetLut(): Promise<void> {
    const params = ($('#spike-params') as HTMLInputElement).value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const raw = ($('#spike-value') as HTMLInputElement).value.trim()
    const value: string | number | null =
      raw === ''
        ? this.lastExport ?? (node.hasNode ? node.newestCube((await this.lutFolder()).dir) : null)
        : /^-?\d+(\.\d+)?$/.test(raw)
          ? parseFloat(raw)
          : raw
    if (value === null) {
      log('No value: export a LUT first or type a value.', 'warn')
      return
    }
    if (!params.length) {
      log('Name at least one parameter to set.', 'warn')
      return
    }
    try {
      const r = await host.trySetLut(params, value)
      if (!r.tried.length) log(`No Lumetri parameter matched ${params.join(', ')}.`, 'warn')
      for (const t of r.tried) {
        const short = (v: host.ParamValue) => JSON.stringify(v.value.length > 120 ? `${v.value.slice(0, 120)}…` : v.value)
        log(`Set #${t.index} ${t.name} on "${r.clip}" to ${JSON.stringify(value)}: ${t.error ?? 'accepted'}; ${short(t.before)} -> ${short(t.after)}`, t.error ? 'warn' : 'info')
      }
      log('Now look at the Program Monitor and the Lumetri panel: did the LUT actually take effect? (Ctrl+Z reverts.)')
      this.showLog(true)
    } catch (e) {
      log(`Set-LUT spike: ${(e as Error).message}`, 'error')
    }
  }

  // -------------------------------------------------------------- session

  private sessionPath(): string {
    return node.join(node.dataDir(), 'session.json')
  }

  private scheduleSave(): void {
    if (!node.hasNode || this.restoring) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), 400)
  }

  private save(): void {
    const frames: Session['frames'] = {}
    for (const role of ROLES) {
      const f = this.frames[role]
      if (f?.path) frames[role] = { path: f.path, label: f.label }
    }
    const s: Session = {
      version: 1,
      frames,
      pairs: this.pairs,
      nextId: this.nextId,
      opts: this.opts,
      radiusScale: this.radiusScale,
      lutSize: this.lutSize,
      lutName: this.lutName,
      lutNameAuto: this.lutNameAuto,
    }
    try {
      node.writeText(this.sessionPath(), JSON.stringify(s, null, 1))
    } catch (e) {
      log(`Could not save session: ${(e as Error).message}`, 'warn')
    }
  }

  private async restore(): Promise<void> {
    this.restoring = true
    try {
      if (!node.hasNode || !node.exists(this.sessionPath())) return
      const s = JSON.parse(node.readText(this.sessionPath())) as Session
      if (s.version !== 1) return
      this.opts = { ...DEFAULT_OPTIONS, ...s.opts }
      this.radiusScale = s.radiusScale ?? 0
      this.lutSize = s.lutSize ?? this.lutSize
      this.lutName = s.lutName ?? this.lutName
      this.lutNameAuto = s.lutNameAuto ?? true
      this.pairs = (s.pairs ?? []).filter((p) => p.source && p.target)
      if (s.radiusScale === undefined && typeof s.radius === 'number') {
        // Older session: one pixel radius for everything. Keep each point's size.
        for (const p of this.pairs) for (const role of ROLES) if (p[role] && p[role]!.r === undefined) p[role]!.r = s.radius
      }
      this.nextId = s.nextId ?? this.pairs.length + 1
      for (const role of ROLES) {
        const f = s.frames?.[role]
        if (f && node.exists(f.path)) await this.loadImage(role, node.readDataUrl(f.path), f.label, f.path)
      }
      if (this.pairs.length) log(`Restored ${this.pairs.length} point pair(s) from the last session.`)
    } catch (e) {
      log(`Could not restore session: ${(e as Error).message}`, 'warn')
    } finally {
      this.restoring = false
      this.syncControls()
    }
  }
}
