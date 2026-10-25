/**
 * Colour-managed sequences. In a sequence whose working colour space is
 * scene-referred (ACEScct, and likely HLG or PQ), Premiere hands effects
 * working-space values (ACEScct is log) and converts to the display only after
 * them. Frames are captured as displayed, so the match is made on display
 * values, and a LUT built for those would land on the wrong encoding.
 *
 * The SDK has no call that converts colours for an effect, so the panel
 * measures what Premiere does after the effect instead: the effect draws a
 * test pattern of known working-space colours (PMLUTP, lut_engine.h), the
 * panel captures the frame and reads what each colour became on screen. That
 * gives D, working → display, as an n³ table. The LUT the effect then needs
 * is D⁻¹ ∘ match ∘ D: show what the camera recorded, match it, and find the
 * working-space value that displays as the matched colour.
 */
import type { Vec3 } from './color.ts'
import { solve } from './linalg.ts'
import { type Lut3D, bakeLut, sampleLutTetra } from './lut.ts'
import type { RgbaImage } from './sample.ts'

/** Grid size of the pattern: 17³ = 4913 colours, ~20 px cells at 1080p. */
export const PROBE_N = 17

/** The effect's LUT text that draws the pattern instead of the picture. */
export const probeText = (n = PROBE_N) => `PMLUTP ${n}`

/**
 * The pattern's grid: n³ cells, close to square, over the whole frame. Same
 * arithmetic as pm::probeGrid in native/src/lut_engine.cpp (IEEE doubles
 * both sides, so they agree).
 */
export function probeLayout(n: number, width: number, height: number): { cols: number; rows: number } {
  const count = n * n * n
  const cols = Math.max(1, Math.ceil(Math.sqrt((count * width) / height)))
  return { cols, rows: Math.ceil(count / cols) }
}

/** Pattern colour of cell idx: red fastest, like a LUT. */
export function probeColour(n: number, idx: number): Vec3 {
  const k = 1 / (n - 1)
  return [(idx % n) * k, (Math.floor(idx / n) % n) * k, Math.floor(idx / (n * n)) * k]
}

export interface Calibration {
  n: number
  /** D: what each pattern colour looked like captured, display-encoded 0..1, n³ × 3 in LUT order. */
  table: number[]
  /** The pattern came back upside down (GPU frames can be bottom-up). */
  flipped: boolean
  /**
   * How surely the pattern was read, 0..1: the share of neighbouring cells
   * where more of a channel drawn also shows at least as much of that
   * channel. Display transforms keep that order (gamut matrices are
   * diagonal-heavy; brightness alone isn't kept, since adding blue can
   * darken); a frame that isn't the pattern scores about a half.
   */
  fit: number
}

function monotone(n: number, table: number[]): number {
  let ok = 0
  let all = 0
  for (let idx = 0; idx < n * n * n; idx++) {
    for (let c = 0; c < 3; c++) {
      const stride = n ** c
      if (Math.floor(idx / stride) % n === n - 1) continue
      all++
      if (table[(idx + stride) * 3 + c] >= table[idx * 3 + c] - 2 / 255) ok++
    }
  }
  return ok / all
}

/**
 * Read the pattern back from a captured frame. Each cell is averaged over its
 * middle half, away from edges that scaling or compression blur. Both
 * vertical orientations are tried; the one whose brightness follows the
 * drawn colours wins (see `fit`). Throws when neither does: the frame isn't the
 * pattern, or it was moved, scaled or blended on its way to the screen.
 */
export function readProbe(img: RgbaImage, n = PROBE_N): Calibration {
  const { cols, rows } = probeLayout(n, img.width, img.height)
  const count = n * n * n
  let best: Calibration | null = null
  for (const flipped of [false, true]) {
    const table: number[] = []
    for (let idx = 0; idx < count; idx++) {
      const col = idx % cols
      const row = Math.floor(idx / cols)
      const x0 = Math.floor(((col + 0.25) * img.width) / cols)
      const x1 = Math.max(x0 + 1, Math.ceil(((col + 0.75) * img.width) / cols))
      let y0 = Math.floor(((row + 0.25) * img.height) / rows)
      let y1 = Math.max(y0 + 1, Math.ceil(((row + 0.75) * img.height) / rows))
      if (flipped) [y0, y1] = [img.height - y1, img.height - y0]
      const sum: Vec3 = [0, 0, 0]
      let k = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * 4
          sum[0] += img.data[i]
          sum[1] += img.data[i + 1]
          sum[2] += img.data[i + 2]
          k++
        }
      }
      table.push(sum[0] / k / 255, sum[1] / k / 255, sum[2] / k / 255)
    }
    // A blank frame is "monotone" too: the pattern must also span a real range.
    const fit = Math.max(...table) - Math.min(...table) > 0.3 ? monotone(n, table) : 0
    if (!best || fit > best.fit) best = { n, table, flipped, fit }
  }
  if (!best || best.fit < 0.95) {
    throw new Error(
      `the captured frame isn't the test pattern (match ${(best?.fit ?? 0).toFixed(2)}). Put the playhead over the target clip, with no other clip covering it, and Motion at its defaults`,
    )
  }
  return best
}

/** D as a LUT: working-space colour in, displayed colour out. */
const displayLut = (cal: Calibration): Lut3D => ({ size: cal.n, data: Float32Array.from(cal.table) })

/**
 * The working-space colour (0..1) that D shows as `want`, nearest to `start`.
 * Levenberg–Marquardt on the interpolated table. Where `want` is beyond what
 * the display can show (past white, outside its gamut) it settles on the
 * closest it can, so highlights and saturated colours clip the way Premiere
 * clips them anyway.
 */
function invert(D: Lut3D, want: Vec3, start: Vec3): Vec3 {
  const tmp: Vec3 = [0, 0, 0]
  const at = (x: Vec3): Vec3 => {
    sampleLutTetra(D, x[0], x[1], x[2], tmp)
    return [tmp[0], tmp[1], tmp[2]]
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const h = 0.25 / (D.size - 1)
  let x: Vec3 = [clamp(start[0]), clamp(start[1]), clamp(start[2])]
  let f = at(x).map((v, c) => v - want[c]) as Vec3
  let err = f[0] ** 2 + f[1] ** 2 + f[2] ** 2
  let lambda = 1e-3
  for (let it = 0; it < 30 && err > 1e-10; it++) {
    // Jacobian by central differences (columns: d/dr, d/dg, d/db).
    const J: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let j = 0; j < 3; j++) {
      const lo: Vec3 = [x[0], x[1], x[2]]
      const hi: Vec3 = [x[0], x[1], x[2]]
      lo[j] = clamp(x[j] - h)
      hi[j] = clamp(x[j] + h)
      const a = at(lo)
      const b = at(hi)
      const span = hi[j] - lo[j]
      for (let i = 0; i < 3; i++) J[i][j] = (b[i] - a[i]) / span
    }
    const JtJ = [0, 1, 2].map((r) => [0, 1, 2].map((c) => J[0][r] * J[0][c] + J[1][r] * J[1][c] + J[2][r] * J[2][c]))
    const Jtf = [0, 1, 2].map((r) => [-(J[0][r] * f[0] + J[1][r] * f[1] + J[2][r] * f[2])])
    let improved = false
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const A = JtJ.map((row, r) => row.map((v, c) => (r === c ? v * (1 + lambda) + 1e-9 : v)))
      let step: number[][]
      try {
        step = solve(A, Jtf)
      } catch {
        lambda *= 10
        continue
      }
      const nx: Vec3 = [clamp(x[0] + step[0][0]), clamp(x[1] + step[1][0]), clamp(x[2] + step[2][0])]
      const nf = at(nx).map((v, c) => v - want[c]) as Vec3
      const nerr = nf[0] ** 2 + nf[1] ** 2 + nf[2] ** 2
      if (nerr < err) {
        x = nx
        f = nf
        err = nerr
        lambda = Math.max(1e-7, lambda / 3)
        improved = true
      } else {
        lambda *= 4
      }
    }
    if (!improved) break
  }
  return x
}

/**
 * The LUT for the effect in a calibrated sequence: for each working-space
 * colour, what it displays as (D), matched (`match`, display to display), and
 * back to the working space (D⁻¹).
 */
export function workingLut(cal: Calibration, match: (displayed: Vec3) => Vec3, size: number): Lut3D {
  const D = displayLut(cal)
  const n = cal.n
  const t = cal.table
  const shown: Vec3 = [0, 0, 0]
  const miss = (x: Vec3, want: Vec3) => {
    sampleLutTetra(D, x[0], x[1], x[2], shown)
    return (shown[0] - want[0]) ** 2 + (shown[1] - want[1]) ** 2 + (shown[2] - want[2]) ** 2
  }
  // Every other measured cell: where to look when the nearby ones are far off.
  const coarse: number[] = []
  for (let b = 0; b < n; b += 2) for (let g = 0; g < n; g += 2) for (let r = 0; r < n; r += 2) coarse.push(r + g * n + b * n * n)
  /** The measured cell that shows closest to `want`: near the input first, then anywhere. */
  const nearestCell = (want: Vec3, w: Vec3): Vec3 => {
    let best = -1
    let bd = Infinity
    const look = (idx: number) => {
      const d = (t[idx * 3] - want[0]) ** 2 + (t[idx * 3 + 1] - want[1]) ** 2 + (t[idx * 3 + 2] - want[2]) ** 2
      if (d < bd) {
        bd = d
        best = idx
      }
    }
    const c = w.map((v) => Math.round(Math.min(1, Math.max(0, v)) * (n - 1)))
    for (let b = Math.max(0, c[2] - 3); b <= Math.min(n - 1, c[2] + 3); b++)
      for (let g = Math.max(0, c[1] - 3); g <= Math.min(n - 1, c[1] + 3); g++)
        for (let r = Math.max(0, c[0] - 3); r <= Math.min(n - 1, c[0] + 3); r++) look(r + g * n + b * n * n)
    for (const idx of coarse) look(idx)
    return probeColour(n, best)
  }
  return bakeLut(size, (w) => {
    sampleLutTetra(D, w[0], w[1], w[2], shown)
    const want = match([shown[0], shown[1], shown[2]])
    // From the input itself (smooth where the display isn't clipped), and
    // from the closest measured cell (where the input sits in a clipped
    // region, the slope there is zero and the first start can't move).
    const a = invert(D, want, w)
    const ea = miss(a, want)
    if (ea < 1e-6) return a
    const b = invert(D, want, nearestCell(want, w))
    return miss(b, want) < ea ? b : a
  })
}

/**
 * A sequence's colour setup, as Premiere reports it (PM_sequenceColour in
 * jsx/host.jsx). It decides both how captures look and what the effect sees,
 * so frames are tagged with the one they were captured under.
 */
export interface ColourSetup {
  working: { name: string; isSceneReferred: boolean; primaries: number; transfer: number; matrix: number }
  autoToneMap: boolean
  gamutCompression: boolean
  linearComposite: boolean
}

/** Equal for setups that capture and render the same way. */
export function setupKey(c: ColourSetup): string {
  const w = c.working
  return JSON.stringify([w.name, w.isSceneReferred, w.primaries, w.transfer, w.matrix, c.autoToneMap, c.gamutCompression, c.linearComposite])
}

/** Short name for labels: the working space, plus the switches that are on. */
export function setupName(c: ColourSetup): string {
  const on = [c.autoToneMap && 'tone mapping', c.gamutCompression && 'gamut compression', c.linearComposite && 'linear compositing'].filter(Boolean)
  return on.length ? `${c.working.name} (${on.join(', ')})` : c.working.name
}

/** Does this working colour space need calibrating? Plain Rec.709 doesn't: effects see the display picture there (spikes P7, P10). */
export function needsCalibration(working: { name: string; isSceneReferred: boolean }): boolean {
  return working.isSceneReferred || !/^Rec\.? ?709$/i.test(working.name.trim())
}
