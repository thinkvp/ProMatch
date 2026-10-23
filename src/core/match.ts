/**
 * The colour match: from point pairs (the same physical spot seen by the
 * source camera and by the target camera) to a function that turns target
 * colours into source colours.
 *
 * It is built in two layers, because the two kinds of camera difference
 * behave differently:
 *
 *   1. GLOBAL, in linear light. Exposure and contrast (a power curve on
 *      luminance — picture profiles differ most in the darks), white balance
 *      (three gains) and sensor/profile crosstalk (a 3x3 matrix). These affect every
 *      colour in the frame, so every pair contributes. The matrix is ridge-
 *      regressed toward the plain exposure x white-balance diagonal, so with
 *      one or two pairs it degrades gracefully to "exposure + balance" instead
 *      of inventing crosstalk it has no evidence for.
 *
 *   2. LOCAL, in Oklab. Whatever error is left at each pair after the global
 *      layer (the apple is still a slightly different red) is removed by a
 *      radial-basis field centred on that pair's colour. Gaussian kernels fall
 *      to zero away from the sampled colours, so fixing the apple moves the
 *      reds and leaves skin, sky and neutrals to the global layer.
 *
 * The result is evaluated on a grid and written out as a 3D LUT (core/lut.ts).
 */
import {
  type Vec3,
  clamp01,
  decodeRgb,
  deltaE,
  encode,
  encodedToOklab,
  linearToOklab,
  luminance,
  oklabToLinear,
  smoothstep,
} from './color.ts'
import { solve } from './linalg.ts'

export interface Sample {
  /** Mean colour of the patch, display-encoded 0..1. */
  rgb: Vec3
  /** Std-dev of encoded luma inside the patch: texture or an edge. */
  spread: number
  /** Enough of the patch is clipped that its colour is not trustworthy. */
  clipped: boolean
}

export interface PairInput {
  source: Sample
  target: Sample
  /** User weight, default 1. */
  weight?: number
}

export type GlobalModel = 'exposure' | 'balance' | 'matrix'

export interface MatchOptions {
  /** Match brightness from the pairs. Off = keep the target's exposure. */
  autoExposure: boolean
  /** Manual nudge on top of everything, in stops. */
  exposureOffset: number
  /** Match contrast (a power curve on luminance) from the pairs — cameras
   *  with different picture profiles differ more in the darks than the brights. */
  matchContrast: boolean
  globalModel: GlobalModel
  /** How strongly the 3x3 matrix is pulled toward plain exposure x balance. */
  matrixRidge: number
  /** 0..1 — how much of the per-colour correction to apply. */
  localStrength: number
  /** Kernel width in Oklab units: how far around each sampled colour the
   *  local correction reaches. 0.12 ≈ "this hue family". */
  colourRange: number
  /** 0..1 — how far a local correction spreads to lighter and darker shades
   *  of the same colour (the shadowed side of the apple). */
  shadeSpread: number
  /** Regularisation for the local fit. Higher = smoother, less exact. */
  smoothing: number
  /** Ease highlights into white instead of hard-clipping when the match
   *  brightens the image. */
  highlightRolloff: boolean
}

export const DEFAULT_OPTIONS: MatchOptions = {
  autoExposure: true,
  exposureOffset: 0,
  matchContrast: true,
  globalModel: 'matrix',
  matrixRidge: 0.15,
  localStrength: 1,
  colourRange: 0.12,
  shadeSpread: 0.5,
  smoothing: 0.03,
  highlightRolloff: true,
}

export interface IgnoredPair {
  index: number
  reason: string
}

export interface MatchModel {
  /** Tone stage, applied first: lin * toneGain * Y^(contrast-1). */
  contrast: number
  toneGain: number
  /** Row-major 3x3, linear light, applied after the tone stage. */
  matrix: number[]
  /** Net brightness change of the global layer, in stops (for display). */
  exposureStops: number
  /** Per-channel white-balance gains (luminance-normalised, for display). */
  balance: Vec3
  outputGain: number
  centres: Vec3[]
  coeffs: Vec3[]
  sigma: number
  lightWeight: number
  maxShift: number
  strength: number
  rolloff: boolean
  /** Brightest encoded value the model produces before roll-off. */
  headroom: number
  used: number
  ignored: IgnoredPair[]
}

const IDENTITY: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const ROLLOFF_KNEE = 0.85
const EPS = 1e-5

interface Usable {
  index: number
  s: Vec3
  t: Vec3
  ys: number
  yt: number
  w: number
}

export function identityModel(): MatchModel {
  return {
    contrast: 1,
    toneGain: 1,
    matrix: [...IDENTITY],
    exposureStops: 0,
    balance: [1, 1, 1],
    outputGain: 1,
    centres: [],
    coeffs: [],
    sigma: 1,
    lightWeight: 1,
    maxShift: 0,
    strength: 0,
    rolloff: false,
    headroom: 1,
    used: 0,
    ignored: [],
  }
}

function mulMat(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

function max0(v: Vec3): Vec3 {
  return [Math.max(0, v[0]), Math.max(0, v[1]), Math.max(0, v[2])]
}

/** Exposure + contrast as one chromaticity-preserving gain per pixel. */
function tone(model: MatchModel, lin: Vec3): Vec3 {
  if (model.contrast === 1 && model.toneGain === 1) return lin
  const f = model.toneGain * Math.pow(Math.max(luminance(lin), 1e-6), model.contrast - 1)
  return [lin[0] * f, lin[1] * f, lin[2] * f]
}

/** The whole global layer: tone, then the colour matrix. */
function globalLin(model: MatchModel, lin: Vec3): Vec3 {
  return max0(mulMat(model.matrix, tone(model, lin)))
}

function kernelDist2(a: Vec3, b: Vec3, lightWeight: number): number {
  const dl = (a[0] - b[0]) * lightWeight
  const da = a[1] - b[1]
  const db = a[2] - b[2]
  return dl * dl + da * da + db * db
}

function selectUsable(pairs: PairInput[], ignored: IgnoredPair[]): Usable[] {
  const usable: Usable[] = []
  pairs.forEach((p, index) => {
    if (p.source.clipped || p.target.clipped) {
      ignored.push({ index, reason: 'clipped' })
      return
    }
    const s = decodeRgb(p.source.rgb)
    const t = decodeRgb(p.target.rgb)
    const ys = luminance(s)
    const yt = luminance(t)
    if (ys < 1e-4 || yt < 1e-4) {
      ignored.push({ index, reason: 'too dark' })
      return
    }
    // Textured or edge patches average two things the cameras may have
    // framed differently, so they count for less — but never nothing.
    const spread = Math.max(p.source.spread, p.target.spread)
    const w = (p.weight ?? 1) / (1 + (spread / 0.08) ** 2)
    if (w <= 0) {
      ignored.push({ index, reason: 'zero weight' })
      return
    }
    usable.push({ index, s, t, ys, yt, w })
  })
  return usable
}

/** Weighted geometric-mean gain per channel, normalised so luminance is unchanged. */
function fitBalance(u: Usable[], k: number): Vec3 {
  const g: Vec3 = [1, 1, 1]
  for (let c = 0; c < 3; c++) {
    let num = 0
    let den = 0
    for (const p of u) {
      // Weight each channel's log-ratio by how much signal it carries: the
      // blue channel of a saturated red apple is mostly noise.
      const wc = p.w * Math.min(p.s[c], p.t[c] * k)
      num += wc * Math.log(Math.max(p.s[c], EPS) / Math.max(p.t[c] * k, EPS))
      den += wc
    }
    g[c] = den > 0 ? Math.exp(num / den) : 1
  }
  const n = luminance(g)
  return [g[0] / n, g[1] / n, g[2] / n]
}

/** Ridge regression of each matrix row toward the prior diagonal. */
function fitMatrix(u: Usable[], prior: number[], ridge: number): number[] {
  // Relative error: a 5% miss on a dark patch matters as much as on a bright one.
  const wr = u.map((p) => p.w / Math.max(p.ys, 0.02) ** 2)
  let scale = 0
  u.forEach((p, i) => {
    scale += wr[i] * (p.t[0] ** 2 + p.t[1] ** 2 + p.t[2] ** 2)
  })
  const lambda = Math.max(ridge * (scale / 3), 1e-9)
  const A: number[][] = [
    [lambda, 0, 0],
    [0, lambda, 0],
    [0, 0, lambda],
  ]
  u.forEach((p, i) => {
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a][b] += wr[i] * p.t[a] * p.t[b]
  })
  const B: number[][] = [0, 1, 2].map((a) => [0, 1, 2].map((r) => lambda * prior[r * 3 + a]))
  u.forEach((p, i) => {
    for (let a = 0; a < 3; a++) for (let r = 0; r < 3; r++) B[a][r] += wr[i] * p.s[r] * p.t[a]
  })
  const X = solve(A, B) // X[a][r] = matrix[r][a]
  const m = new Array<number>(9)
  for (let r = 0; r < 3; r++) for (let a = 0; a < 3; a++) m[r * 3 + a] = X[a][r]
  return m
}

/** Weighted geometric-mean luminance change a global transform applies to the pairs. */
function netExposure(u: Usable[], fn: (t: Vec3) => Vec3): number {
  let num = 0
  let den = 0
  for (const p of u) {
    const y = luminance(fn(p.t))
    num += p.w * Math.log(Math.max(y, EPS) / p.yt)
    den += p.w
  }
  return den > 0 ? Math.exp(num / den) : 1
}

export function fitMatch(pairs: PairInput[], opts: MatchOptions = DEFAULT_OPTIONS): MatchModel {
  const model = identityModel()
  const u = selectUsable(pairs, model.ignored)
  model.used = u.length
  model.outputGain = Math.pow(2, opts.exposureOffset)
  model.rolloff = opts.highlightRolloff

  if (u.length > 0) {
    fitTone(model, u, opts)
    // Balance and matrix are fitted on the toned targets, so they only have
    // to explain colour, not brightness.
    const ut = u.map((p) => {
      const t = tone(model, p.t)
      return { ...p, t, yt: luminance(t) }
    })
    const g: Vec3 = opts.globalModel === 'exposure' ? [1, 1, 1] : fitBalance(ut, 1)
    model.balance = g
    const diag = [g[0], 0, 0, 0, g[1], 0, 0, 0, g[2]]
    model.matrix = opts.globalModel === 'matrix' ? fitMatrix(ut, diag, opts.matrixRidge) : diag
    if (!opts.autoExposure) {
      // The free matrix matches brightness whether asked to or not; take
      // that back out when auto exposure is off.
      const e = netExposure(u, (t) => globalLin(model, t))
      model.matrix = model.matrix.map((v) => v / e)
    }
    model.exposureStops = Math.log2(netExposure(u, (t) => globalLin(model, t)))

    if (opts.localStrength > 0) fitLocal(model, u, opts)
  }

  model.headroom = measureHeadroom(model)
  return model
}

/**
 * Weighted regression of log source luminance on log target luminance:
 * slope = contrast, intercept = exposure. The slope is pulled toward 1 and
 * needs pairs at different brightnesses to move at all.
 */
function fitTone(model: MatchModel, u: Usable[], opts: MatchOptions): void {
  let sw = 0
  let xm = 0
  let ym = 0
  for (const p of u) {
    sw += p.w
    xm += p.w * Math.log(p.yt)
    ym += p.w * Math.log(p.ys)
  }
  xm /= sw
  ym /= sw
  let gamma = 1
  if (opts.matchContrast && u.length >= 2) {
    let sxx = 0
    let sxy = 0
    for (const p of u) {
      const dx = Math.log(p.yt) - xm
      sxx += p.w * dx * dx
      sxy += p.w * dx * (Math.log(p.ys) - ym)
    }
    const lambda = 0.05 * sw
    gamma = Math.min(2, Math.max(0.5, (sxy + lambda) / (sxx + lambda)))
  }
  // Without auto exposure, pivot the curve so the pairs' average brightness stays put.
  const c = opts.autoExposure ? ym - gamma * xm : (1 - gamma) * xm
  model.contrast = gamma
  model.toneGain = Math.exp(c)
}

function fitLocal(model: MatchModel, u: Usable[], opts: MatchOptions): void {
  const lightWeight = 1 - 0.8 * clamp01(opts.shadeSpread)
  const sigma = Math.max(opts.colourRange, 0.01)
  const centres = u.map((p) => linearToOklab(globalLin(model, p.t)))
  const wanted = u.map((p) => linearToOklab(p.s))
  const resid = wanted.map((s, i) => [s[0] - centres[i][0], s[1] - centres[i][1], s[2] - centres[i][2]])
  const n = u.length
  const meanW = u.reduce((a, p) => a + p.w, 0) / n
  const mu = Math.max(opts.smoothing, 1e-3)
  const Phi: number[][] = []
  for (let i = 0; i < n; i++) {
    Phi.push([])
    for (let j = 0; j < n; j++) {
      Phi[i].push(Math.exp(-kernelDist2(centres[i], centres[j], lightWeight) / (2 * sigma * sigma)))
    }
    // Less trusted pairs are fitted less exactly.
    Phi[i][i] += mu * (meanW / u[i].w)
  }
  const coeffs = solve(Phi, resid)
  let maxShift = 0
  for (const r of resid) maxShift = Math.max(maxShift, Math.hypot(r[0], r[1], r[2]))
  model.centres = centres
  model.coeffs = coeffs.map((c) => [c[0], c[1], c[2]] as Vec3)
  model.sigma = sigma
  model.lightWeight = lightWeight
  // Overlapping kernels with disagreeing pairs can overshoot between them;
  // never move a colour further than the biggest correction asked for.
  model.maxShift = maxShift * 1.05
  model.strength = clamp01(opts.localStrength)
}

/** The model up to (not including) highlight roll-off and the final clamp. */
function applyLinear(model: MatchModel, enc: Vec3): Vec3 {
  let lin = globalLin(model, decodeRgb(enc))
  if (model.strength > 0 && model.centres.length > 0) {
    const lab = linearToOklab(lin)
    let d0 = 0
    let d1 = 0
    let d2 = 0
    const inv = 1 / (2 * model.sigma * model.sigma)
    for (let j = 0; j < model.centres.length; j++) {
      const phi = Math.exp(-kernelDist2(lab, model.centres[j], model.lightWeight) * inv)
      if (phi < 1e-6) continue
      const c = model.coeffs[j]
      d0 += phi * c[0]
      d1 += phi * c[1]
      d2 += phi * c[2]
    }
    const mag = Math.hypot(d0, d1, d2)
    let f = model.strength * smoothstep(0, 0.08, lab[0]) // keep true black black
    if (mag > model.maxShift && mag > 0) f *= model.maxShift / mag
    if (f > 0) lin = max0(oklabToLinear([lab[0] + f * d0, lab[1] + f * d1, lab[2] + f * d2]))
  }
  const g = model.outputGain
  return [encode(lin[0] * g), encode(lin[1] * g), encode(lin[2] * g)]
}

function rolloff(v: number, headroom: number): number {
  if (v <= ROLLOFF_KNEE) return v
  // Maps [knee, headroom] onto [knee, 1] with slope 1 at the knee and 0 at
  // the top, so it is invisible below the knee and only engages when the
  // match actually pushes values past white.
  const p = (headroom - ROLLOFF_KNEE) / (1 - ROLLOFF_KNEE)
  const t = Math.min((v - ROLLOFF_KNEE) / (headroom - ROLLOFF_KNEE), 1)
  return ROLLOFF_KNEE + (1 - ROLLOFF_KNEE) * (1 - Math.pow(1 - t, p))
}

function measureHeadroom(model: MatchModel): number {
  let h = 1
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [i & 1 ? 1 : 0, i & 2 ? 1 : 0, i & 4 ? 1 : 0]
    const o = applyLinear(model, corner)
    h = Math.max(h, o[0], o[1], o[2])
  }
  return Math.min(h, 4)
}

/** Target colour (encoded) -> matched colour (encoded, clamped 0..1). */
export function applyModel(model: MatchModel, enc: Vec3): Vec3 {
  const o = applyLinear(model, enc)
  if (model.rolloff && model.headroom > 1.0001) {
    return [rolloff(o[0], model.headroom), rolloff(o[1], model.headroom), rolloff(o[2], model.headroom)]
  }
  return [clamp01(o[0]), clamp01(o[1]), clamp01(o[2])]
}

export interface PairReport {
  index: number
  used: boolean
  reason?: string
  before: number
  after: number
  matched: Vec3
}

/** Per-pair error before and after the match (Oklab ΔE x100). */
export function reportPairs(model: MatchModel, pairs: PairInput[]): PairReport[] {
  return pairs.map((p, index) => {
    const ig = model.ignored.find((g) => g.index === index)
    const matched = applyModel(model, p.target.rgb)
    const s = encodedToOklab(p.source.rgb)
    return {
      index,
      used: !ig,
      reason: ig?.reason,
      before: deltaE(encodedToOklab(p.target.rgb), s),
      after: deltaE(encodedToOklab(matched), s),
      matched,
    }
  })
}

/**
 * Held-out ("tested") error per pair: refit without that pair and measure
 * how close the match gets there. Unlike the fitted error it cannot be gamed
 * — a match bent tightly around each point (narrow colour range, low
 * smoothing) scores well on the points it was fitted to and badly here,
 * which is what such a match looks like on screen. On a real interview,
 * over-tuning took the fitted error from 2.39 to 0.27 while this rose from
 * 4.66 to 7.35. A pair whose own tested error is far above the rest is one
 * the other pairs disagree with: wrong spot, blur, shadow on one side.
 * Null when there are fewer than 3 pairs to test with.
 */
export function crossValidate(pairs: PairInput[], opts: MatchOptions = DEFAULT_OPTIONS): number[] | null {
  if (pairs.length < 3) return null
  return pairs.map((p, i) => {
    const model = fitMatch(
      pairs.filter((_, j) => j !== i),
      opts,
    )
    return deltaE(encodedToOklab(applyModel(model, p.target.rgb)), encodedToOklab(p.source.rgb))
  })
}

function median(v: number[]): number {
  const sorted = [...v].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Indices of pairs the others disagree with, found one at a time: take the
 * pair with the worst tested error; if it stands far above the rest, flag
 * it, refit WITHOUT it and look again. One bad pick drags the whole match
 * off and gives honest neighbours high errors too, so judging everything in
 * a single pass flags innocent pairs (typically the one colour nothing else
 * covers). Needs 6+ pairs, never flags more than a third of them, and the
 * bar is high (3x the others, at least 8): it is a "check this pick" hint,
 * not a verdict — a lone colour with a real camera twist can look the same.
 */
export function disagreeing(pairs: PairInput[], opts: MatchOptions = DEFAULT_OPTIONS): number[] {
  const flagged: number[] = []
  let idx = pairs.map((_, i) => i)
  while (idx.length >= 6 && flagged.length < Math.floor(pairs.length / 3)) {
    const tested = crossValidate(
      idx.map((i) => pairs[i]),
      opts,
    )!
    let worst = 0
    for (let k = 1; k < tested.length; k++) if (tested[k] > tested[worst]) worst = k
    const rest = tested.filter((_, k) => k !== worst)
    if (tested[worst] <= Math.max(8, 3 * median(rest))) break
    flagged.push(idx[worst])
    idx = idx.filter((_, k) => k !== worst)
  }
  return flagged
}
