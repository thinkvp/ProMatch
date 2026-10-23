/**
 * Auto: suggest point pairs without the user clicking.
 *
 * The two frames show the same room through different cameras, so they hold
 * the same *colours* even where the framing differs. We cluster the source
 * frame's colours, then repeatedly:
 *   1. bring the target's colours close to the source's with the current
 *      match (first pass: a robust mean/spread transfer),
 *   2. give each target pixel to its nearest source colour cluster,
 *   3. refit the match from the cluster means.
 * It is ICP in colour space: correspondences and match converge together.
 *
 * Each surviving cluster becomes an ordinary editable pair, seeded at the
 * most "interior" pixel of that colour in each frame, so the user reviews
 * suggestions instead of placing every point — and can delete bad ones.
 */
import { encode, encodedToOklab, type Vec3 } from './color.ts'
import { DEFAULT_OPTIONS, type PairInput, applyModel, fitMatch } from './match.ts'
import type { Analysis } from './analysis.ts'

export interface Suggestion {
  source: { x: number; y: number }
  target: { x: number; y: number }
  /** Smaller of the two frames' pixel shares for this colour. */
  share: number
}

export interface AutoOptions {
  clusters: number
  maxPairs: number
  /** Minimum share of each frame a colour must cover to be used. */
  minShare: number
  /** How close (Oklab) an aligned target pixel must be to a cluster to join it. */
  assignDistance: number
  iterations: number
}

export const DEFAULT_AUTO: AutoOptions = { clusters: 12, maxPairs: 8, minShare: 0.015, assignDistance: 0.07, iterations: 4 }

const SAMPLE_TARGET = 30000

/** Deterministic PRNG so Auto gives the same answer twice. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Pixel offsets (into lab/lin) of a strided subsample, skipping near-black and clipped. */
function subsample(a: Analysis): number[] {
  const step = Math.max(1, Math.floor(Math.sqrt((a.width * a.height) / SAMPLE_TARGET)))
  const out: number[] = []
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const o = (y * a.width + x) * 3
      const L = a.lab[o]
      if (L < 0.12 || L > 0.97) continue
      out.push(o)
    }
  }
  return out
}

function dist2(a: Float32Array | number[], o: number, c: Vec3): number {
  const dl = a[o] - c[0]
  const da = a[o + 1] - c[1]
  const db = a[o + 2] - c[2]
  return dl * dl + da * da + db * db
}

function kmeans(a: Analysis, px: number[], k: number): Vec3[] {
  const rand = rng(1234)
  // k-means++ seeding.
  const centres: Vec3[] = []
  const first = px[Math.floor(rand() * px.length)]
  centres.push([a.lab[first], a.lab[first + 1], a.lab[first + 2]])
  const d = new Float64Array(px.length).fill(Infinity)
  while (centres.length < k) {
    let sum = 0
    const c = centres[centres.length - 1]
    for (let i = 0; i < px.length; i++) {
      d[i] = Math.min(d[i], dist2(a.lab, px[i], c))
      sum += d[i]
    }
    let r = rand() * sum
    let pick = px.length - 1
    for (let i = 0; i < px.length; i++) {
      r -= d[i]
      if (r <= 0) {
        pick = i
        break
      }
    }
    const o = px[pick]
    centres.push([a.lab[o], a.lab[o + 1], a.lab[o + 2]])
  }
  for (let iter = 0; iter < 12; iter++) {
    const acc = centres.map(() => [0, 0, 0, 0])
    for (const o of px) {
      let best = 0
      let bd = Infinity
      for (let j = 0; j < k; j++) {
        const dd = dist2(a.lab, o, centres[j])
        if (dd < bd) {
          bd = dd
          best = j
        }
      }
      acc[best][0] += a.lab[o]
      acc[best][1] += a.lab[o + 1]
      acc[best][2] += a.lab[o + 2]
      acc[best][3]++
    }
    for (let j = 0; j < k; j++) if (acc[j][3]) centres[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]]
  }
  return centres
}

function nearest(lab: Float32Array | number[], o: number, centres: Vec3[], maxD2: number): number {
  let best = -1
  let bd = maxD2
  for (let j = 0; j < centres.length; j++) {
    const dd = dist2(lab, o, centres[j])
    if (dd < bd) {
      bd = dd
      best = j
    }
  }
  return best
}

/** Robust mean/std per Oklab channel over a pixel list (central 90%). */
function robustStats(lab: Float32Array, px: number[]): { mean: Vec3; std: Vec3 } {
  const mean: Vec3 = [0, 0, 0]
  const std: Vec3 = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const v = px.map((o) => lab[o + c]).sort((p, q) => p - q)
    const lo = Math.floor(v.length * 0.05)
    const hi = Math.ceil(v.length * 0.95)
    const s = v.slice(lo, hi)
    const m = s.reduce((x, y) => x + y, 0) / s.length
    mean[c] = m
    std[c] = Math.sqrt(s.reduce((x, y) => x + (y - m) * (y - m), 0) / s.length) || 1e-3
  }
  return { mean, std }
}

function meanEncoded(a: Analysis, px: number[]): Vec3 {
  let r = 0
  let g = 0
  let b = 0
  for (const o of px) {
    r += a.lin[o]
    g += a.lin[o + 1]
    b += a.lin[o + 2]
  }
  const n = Math.max(1, px.length)
  return [encode(r / n), encode(g / n), encode(b / n)]
}

/** The pixel of a label that sits deepest inside a patch of that label. */
function interiorPoint(labels: Int8Array, w: number, h: number, label: number, win: number): { x: number; y: number; score: number } {
  // Integral image of the label's indicator, then the best box sum.
  const I = new Int32Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += labels[y * w + x] === label ? 1 : 0
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row
    }
  }
  let best = { x: 0, y: 0, score: -1 }
  // Keep seeds off the frame edges (vignetting, letterbox, half-visible objects).
  const m = Math.max(win, Math.round(Math.min(w, h) * 0.05))
  for (let y = m; y < h - m; y++) {
    for (let x = m; x < w - m; x++) {
      if (labels[y * w + x] !== label) continue
      const s =
        I[(y + win + 1) * (w + 1) + x + win + 1] - I[(y - win) * (w + 1) + x + win + 1] - I[(y + win + 1) * (w + 1) + x - win] + I[(y - win) * (w + 1) + x - win]
      if (s > best.score) best = { x, y, score: s }
    }
  }
  return best
}

export function suggestPairs(src: Analysis, tgt: Analysis, opts: AutoOptions = DEFAULT_AUTO): Suggestion[] {
  const sp = subsample(src)
  const tp = subsample(tgt)
  if (sp.length < 100 || tp.length < 100) return []
  const centres = kmeans(src, sp, opts.clusters)
  const srcLabel = sp.map((o) => nearest(src.lab, o, centres, Infinity))

  // First alignment: move the target's colour distribution onto the source's.
  const ss = robustStats(src.lab, sp)
  const ts = robustStats(tgt.lab, tp)
  let aligned = new Float32Array(tp.length * 3)
  tp.forEach((o, i) => {
    for (let c = 0; c < 3; c++) aligned[i * 3 + c] = ((tgt.lab[o + c] - ts.mean[c]) / ts.std[c]) * ss.std[c] + ss.mean[c]
  })

  const maxD2 = opts.assignDistance * opts.assignDistance
  let keep: number[] = []
  let tgtLabel: number[] = []
  for (let iter = 0; iter < opts.iterations; iter++) {
    tgtLabel = tp.map((_, i) => nearest(aligned, i * 3, centres, maxD2))
    const pairs: PairInput[] = []
    keep = []
    for (let j = 0; j < centres.length; j++) {
      const sIn = sp.filter((_, i) => srcLabel[i] === j)
      const tIn = tp.filter((_, i) => tgtLabel[i] === j)
      if (sIn.length / sp.length < opts.minShare || tIn.length / tp.length < opts.minShare) continue
      keep.push(j)
      const w = Math.sqrt(Math.min(sIn.length / sp.length, tIn.length / tp.length))
      pairs.push({ source: { rgb: meanEncoded(src, sIn), spread: 0, clipped: false }, target: { rgb: meanEncoded(tgt, tIn), spread: 0, clipped: false }, weight: w })
    }
    if (pairs.length < 2) break
    // Global-only refit: the local layer would bend to fit wrong early guesses.
    const model = fitMatch(pairs, { ...DEFAULT_OPTIONS, localStrength: 0 })
    const next = new Float32Array(tp.length * 3)
    tp.forEach((o, i) => {
      const lin: Vec3 = [tgt.lin[o], tgt.lin[o + 1], tgt.lin[o + 2]]
      const lab = encodedToOklab(applyModel(model, [encode(lin[0]), encode(lin[1]), encode(lin[2])]))
      next[i * 3] = lab[0]
      next[i * 3 + 1] = lab[1]
      next[i * 3 + 2] = lab[2]
    })
    aligned = next
  }

  // Seed each kept colour where it forms the biggest solid patch in each frame.
  const labelMap = (a: Analysis, assign: (o: number) => number) => {
    const m = new Int8Array(a.width * a.height).fill(-1)
    for (let i = 0; i < a.width * a.height; i++) {
      const L = a.lab[i * 3]
      if (L >= 0.12 && L <= 0.97) m[i] = assign(i * 3)
    }
    return m
  }
  const sMap = labelMap(src, (o) => nearest(src.lab, o, centres, Infinity))
  // Target pixels are labelled through the converged alignment, recomputed per pixel.
  const tAligned = new Float32Array(tgt.width * tgt.height * 3)
  {
    const pairs: PairInput[] = keep.map((j) => ({
      source: { rgb: meanEncoded(src, sp.filter((_, i) => srcLabel[i] === j)), spread: 0, clipped: false },
      target: { rgb: meanEncoded(tgt, tp.filter((_, i) => tgtLabel[i] === j)), spread: 0, clipped: false },
    }))
    const model = pairs.length >= 2 ? fitMatch(pairs, { ...DEFAULT_OPTIONS, localStrength: 0 }) : null
    for (let i = 0; i < tgt.width * tgt.height; i++) {
      const o = i * 3
      if (!model) {
        for (let c = 0; c < 3; c++) tAligned[o + c] = ((tgt.lab[o + c] - ts.mean[c]) / ts.std[c]) * ss.std[c] + ss.mean[c]
        continue
      }
      const lab = encodedToOklab(applyModel(model, [encode(tgt.lin[o]), encode(tgt.lin[o + 1]), encode(tgt.lin[o + 2])]))
      tAligned[o] = lab[0]
      tAligned[o + 1] = lab[1]
      tAligned[o + 2] = lab[2]
    }
  }
  const tMap = labelMap(tgt, (o) => nearest(tAligned, o, centres, maxD2))
  const win = Math.max(2, Math.round(Math.min(src.width, tgt.width) / 120))
  const candidates: Array<Suggestion & { centre: Vec3 }> = []
  for (const j of keep) {
    const s = interiorPoint(sMap, src.width, src.height, j, win)
    const t = interiorPoint(tMap, tgt.width, tgt.height, j, win)
    if (s.score <= 0 || t.score <= 0) continue
    const full = (win * 2 + 1) ** 2
    // Only patches that are mostly this colour make trustworthy seeds.
    if (s.score < full * 0.6 || t.score < full * 0.6) continue
    const share = Math.min(sp.filter((_, i) => srcLabel[i] === j).length / sp.length, tp.filter((_, i) => tgtLabel[i] === j).length / tp.length)
    candidates.push({
      source: { x: (s.x + 0.5) * src.scale, y: (s.y + 0.5) * src.scale },
      target: { x: (t.x + 0.5) * tgt.scale, y: (t.y + 0.5) * tgt.scale },
      share,
      centre: centres[j],
    })
  }
  return pickDiverse(candidates, opts.maxPairs).map(({ centre: _c, ...rest }) => rest)
}

/**
 * Choose pairs that cover the palette, not just its biggest colour: a dark
 * wall splits into several near-identical shades that would otherwise fill
 * every slot. Greedy farthest-point selection in Oklab, weighted by size.
 */
function pickDiverse<T extends { share: number; centre: Vec3 }>(items: T[], max: number): T[] {
  const left = [...items].sort((p, q) => q.share - p.share)
  const chosen: T[] = []
  if (left.length) chosen.push(left.shift()!)
  while (chosen.length < max && left.length) {
    let bi = 0
    let bs = -1
    left.forEach((c, i) => {
      let dmin = Infinity
      for (const k of chosen) {
        const dl = (c.centre[0] - k.centre[0]) * 0.7
        const da = c.centre[1] - k.centre[1]
        const db = c.centre[2] - k.centre[2]
        dmin = Math.min(dmin, Math.sqrt(dl * dl + da * da + db * db))
      }
      const score = dmin * Math.sqrt(c.share)
      if (score > bs) {
        bs = score
        bi = i
      }
    })
    chosen.push(left.splice(bi, 1)[0])
  }
  return chosen
}
