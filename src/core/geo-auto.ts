/**
 * Auto v2: pairs at the SAME physical place in both frames.
 *
 * Feature matches (from OpenCV's AKAZE, see panel/features.ts) are grouped
 * into planes (homography.ts). Keypoints sit on texture and edges, which are
 * bad places to read a colour, so they are not used as pairs themselves.
 * Instead each plane is searched for flat, unclipped spots near its own
 * matches (a homography is only trusted close to the points that fitted
 * it); each spot is mapped through the plane to the other frame and must be
 * flat there too. Then the set is thinned for spread and colour variety, and
 * pairs whose colours disagree with the consensus are dropped — the guard
 * against a spot that sits on a different depth than its plane.
 *
 * Measured on a real two-camera interview (spikes/SPIKES.md): faces,
 * picture frames and shirts match well; bare walls and plain sofas have no
 * texture to match, so they stay manual picks.
 */
import { decodeRgb, deltaE, encodedToOklab, luminance, type Vec3 } from './color.ts'
import { type Correspondence, type Homography, type Pt, applyH, findPlanes } from './homography.ts'
import { DEFAULT_OPTIONS, type PairInput, applyModel, fitMatch, type Sample } from './match.ts'
import { type RgbaImage, sampleDisc } from './sample.ts'

export interface GeoSuggestion {
  source: { x: number; y: number }
  target: { x: number; y: number }
  /** Index of the plane it came from (for display/debug). */
  plane: number
}

export interface GeoAutoOptions {
  maxPairs: number
  perPlane: number
  /** Grid spacing as a fraction of the source width. */
  gridStep: number
  /** Max luma std-dev inside a spot (encoded 0..1) for it to count as flat. */
  maxSpread: number
  /** How far from its plane's matches a spot may be, as a fraction of width. */
  reach: number
  /** Minimum matches within `reach` of a spot. */
  support: number
}

export const DEFAULT_GEO: GeoAutoOptions = { maxPairs: 10, perPlane: 4, gridStep: 1 / 48, maxSpread: 0.03, reach: 0.06, support: 3 }

export interface GeoAutoResult {
  suggestions: GeoSuggestion[]
  planes: Array<{ H: Homography; matches: number }>
  matches: number
  candidates: number
  rejected: number
}

interface Candidate {
  a: Pt
  b: Pt
  plane: number
  flat: number
  s: Sample
  t: Sample
}

/** Image scale of a homography around p (how much bigger things are in the target). */
function localScale(H: Homography, p: Pt, r: number): number {
  const o = applyH(H, p)
  const x = applyH(H, [p[0] + r, p[1]])
  const y = applyH(H, [p[0], p[1] + r])
  return (Math.hypot(x[0] - o[0], x[1] - o[1]) + Math.hypot(y[0] - o[0], y[1] - o[1])) / (2 * r)
}

export function suggestFromMatches(matches: Correspondence[], src: RgbaImage, tgt: RgbaImage, opts: GeoAutoOptions = DEFAULT_GEO): GeoAutoResult {
  const planes = findPlanes(matches, 0.004 * tgt.width)
  const step = Math.max(4, src.width * opts.gridStep)
  const rS = Math.max(5, src.width / 160)
  const reach = opts.reach * src.width
  const mx = 0.03 * tgt.width
  const my = 0.03 * tgt.height
  const cands: Candidate[] = []

  planes.forEach((pl, pi) => {
    for (let y = step / 2; y < src.height; y += step) {
      for (let x = step / 2; x < src.width; x += step) {
        let near = 0
        for (const m of pl.members) if (Math.hypot(m.a[0] - x, m.a[1] - y) <= reach) near++
        if (near < opts.support) continue
        const a: Pt = [x, y]
        const b = applyH(pl.H, a)
        if (!(b[0] > mx && b[1] > my && b[0] < tgt.width - mx && b[1] < tgt.height - my)) continue
        const scale = localScale(pl.H, a, rS)
        if (!(scale > 0.2 && scale < 5)) continue
        const s = sampleDisc(src, x, y, rS)
        if (s.clipped || s.spread > opts.maxSpread) continue
        const t = sampleDisc(tgt, b[0], b[1], Math.max(3, rS * scale))
        if (t.clipped || t.spread > opts.maxSpread) continue
        if (luminance(decodeRgb(s.rgb)) < 0.003 || luminance(decodeRgb(t.rgb)) < 0.003) continue
        cands.push({ a, b, plane: pi, flat: s.spread + t.spread, s, t })
      }
    }
  })

  // Per plane: as many colours as possible, kept apart from each other. The
  // flattest spot of a plane is usually its biggest plain area (the wall),
  // so choosing by flatness alone would fill every slot with one colour.
  const minSep = 0.05 * src.width
  const quota = Math.max(opts.perPlane, Math.ceil((opts.maxPairs * 1.5) / Math.max(1, planes.length)))
  let chosen: Candidate[] = []
  planes.forEach((_, pi) => {
    const mine = cands.filter((c) => c.plane === pi).sort((p, q) => p.flat - q.flat)
    chosen.push(...pickVaried(mine, quota, minSep))
  })

  // Consensus check: a spot that landed on a different depth than its plane
  // reads a different object in the target, and its colours disagree with
  // what every other pair says the camera difference is.
  let rejected = 0
  for (let round = 0; round < 2 && chosen.length >= 4; round++) {
    const inputs: PairInput[] = chosen.map((c) => ({ source: c.s, target: c.t }))
    const model = fitMatch(inputs, { ...DEFAULT_OPTIONS, localStrength: 0 })
    const res = chosen.map((c) => deltaE(encodedToOklab(applyModel(model, c.t.rgb)), encodedToOklab(c.s.rgb)))
    const med = [...res].sort((p, q) => p - q)[Math.floor(res.length / 2)]
    const limit = Math.max(5, 2.5 * med)
    const keep = chosen.filter((_, i) => res[i] <= limit)
    rejected += chosen.length - keep.length
    if (keep.length === chosen.length) break
    chosen = keep
  }

  const final = pickVaried([...chosen].sort((p, q) => p.flat - q.flat), opts.maxPairs, 0)
  return {
    suggestions: final.map((c) => ({ source: { x: c.a[0], y: c.a[1] }, target: { x: c.b[0], y: c.b[1] }, plane: c.plane })),
    planes: planes.map((p) => ({ H: p.H, matches: p.members.length })),
    matches: matches.length,
    candidates: cands.length,
    rejected,
  }
}

/**
 * Up to `max` items with the widest colour range: greedy farthest-point in
 * Oklab, starting from the first item (callers pass them flattest first),
 * never closer than `minSep` px to an already chosen spot.
 */
function pickVaried(items: Candidate[], max: number, minSep: number): Candidate[] {
  if (!items.length) return []
  const lab = new Map(items.map((c) => [c, encodedToOklab(c.s.rgb) as Vec3]))
  const chosen = [items[0]]
  let left = items.slice(1)
  while (chosen.length < max) {
    left = left.filter((c) => chosen.every((k) => Math.hypot(k.a[0] - c.a[0], k.a[1] - c.a[1]) >= minSep))
    if (!left.length) break
    let bi = 0
    let bd = -1
    left.forEach((c, i) => {
      const l = lab.get(c)!
      const d = Math.min(...chosen.map((k) => deltaE(l, lab.get(k)!)))
      if (d > bd) {
        bd = d
        bi = i
      }
    })
    chosen.push(left.splice(bi, 1)[0])
  }
  return chosen
}
