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
 * Faces get their own pairs from the face mesh (faces.ts) when the caller
 * could run it: landmark n is the same spot on the face in both frames, so
 * skin pairs don't depend on a face being close to a plane. They have their
 * own quota, because colour variety alone would pick one skin spot at most.
 *
 * Measured on a real two-camera interview (spikes/SPIKES.md): faces,
 * picture frames and shirts match well; bare walls and plain sofas have no
 * texture to match, so they stay manual picks.
 */
import { decodeRgb, deltaE, encodedToOklab, luminance, type Vec3 } from './color.ts'
import type { FaceMesh } from './faces.ts'
import { type Correspondence, type Homography, type Pt, applyH, findPlanes } from './homography.ts'
import { DEFAULT_OPTIONS, type PairInput, applyModel, fitMatch, type Sample } from './match.ts'
import { type RgbaImage, sampleDisc } from './sample.ts'

export interface GeoSuggestion {
  /** r: the disc radius the spot was checked with, sized to the object in that frame. */
  source: { x: number; y: number; r: number }
  target: { x: number; y: number; r: number }
  /** Index of the plane it came from (for display/debug); -1 for a face. */
  plane: number
}

export interface GeoAutoOptions {
  /** Pairs from planes; face pairs come on top. */
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
  /** Fewest feature matches that make a plane, and most planes kept. */
  planeMin: number
  maxPlanes: number
  /** Skin pairs per face. */
  perFace: number
}

export const DEFAULT_GEO: GeoAutoOptions = {
  maxPairs: 16,
  perPlane: 4,
  gridStep: 1 / 48,
  maxSpread: 0.03,
  reach: 0.06,
  support: 3,
  planeMin: 12,
  maxPlanes: 6,
  perFace: 6,
}

export interface GeoAutoResult {
  suggestions: GeoSuggestion[]
  planes: Array<{ H: Homography; matches: number }>
  matches: number
  candidates: number
  rejected: number
  /** Faces paired across the two frames. */
  faces: number
}

interface Candidate {
  a: Pt
  b: Pt
  ra: number
  rb: number
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

/**
 * Mesh landmarks on open skin: forehead, cheeks, nose bridge, chin, away
 * from brows, eyes, lips and the outline. MediaPipe's numbering; mirrored
 * landmarks are listed person's right, then left.
 */
const SKIN = [151, 9, 108, 337, 69, 299, 50, 280, 205, 425, 117, 346, 101, 330, 36, 266, 187, 411, 195, 5, 199, 175, 200]

/**
 * How squarely the face at landmark i faces the camera, 0..1 (the cosine of
 * the angle). The far cheek of a turned head is seen edge-on: its colour
 * shifts with the angle, and a disc there runs onto the background. From the
 * mesh's nearest 3D neighbours: the area they span on screen over their
 * area in 3D.
 */
export function facing(m: FaceMesh, i: number): number {
  const p = [m.pts[i][0], m.pts[i][1], m.z[i]]
  const near = m.pts
    .map((q, j) => ({ j, d: Math.hypot(q[0] - p[0], q[1] - p[1], m.z[j] - p[2]) }))
    .filter((n) => n.j !== i)
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map(({ j }) => [m.pts[j][0] - p[0], m.pts[j][1] - p[1], m.z[j] - p[2]])
  let flat = 0
  let full = 0
  for (let a = 0; a < near.length; a++) {
    for (let b = a + 1; b < near.length; b++) {
      const [x1, y1, z1] = near[a]
      const [x2, y2, z2] = near[b]
      const cz = x1 * y2 - y1 * x2
      flat += Math.abs(cz)
      full += Math.hypot(y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, cz)
    }
  }
  return full > 0 ? flat / full : 0
}

/** Distance between the eyes' outer corners: the face's size in that frame. */
const eyeSpan = (m: FaceMesh) => Math.hypot(m.pts[263][0] - m.pts[33][0], m.pts[263][1] - m.pts[33][1])

/**
 * Which source face is which target face. One each: those two. More: map
 * each source face's nose through the plane with a match closest to it and
 * take the target face whose box it lands in. Anything else is left out
 * rather than guessed.
 */
export function pairFaces(a: FaceMesh[], b: FaceMesh[], planes: Array<{ H: Homography; members: Correspondence[] }>): Array<[FaceMesh, FaceMesh]> {
  if (a.length === 1 && b.length === 1) return [[a[0], b[0]]]
  const out: Array<[FaceMesh, FaceMesh]> = []
  for (const fa of a) {
    const nose = fa.pts[4]
    let best: { H: Homography; d: number } | null = null
    for (const pl of planes) {
      for (const m of pl.members) {
        const d = Math.hypot(m.a[0] - nose[0], m.a[1] - nose[1])
        if (!best || d < best.d) best = { H: pl.H, d }
      }
    }
    if (!best || best.d > eyeSpan(fa)) continue
    const q = applyH(best.H, nose)
    const fb = b.find((f) => {
      const [x, y, w, h] = f.face.box
      return q[0] >= x && q[0] <= x + w && q[1] >= y && q[1] <= y + h
    })
    if (fb && !out.some((p) => p[1] === fb)) out.push([fa, fb])
  }
  return out
}

export function suggestFromMatches(
  matches: Correspondence[],
  src: RgbaImage,
  tgt: RgbaImage,
  opts: GeoAutoOptions = DEFAULT_GEO,
  faces: { source: FaceMesh[]; target: FaceMesh[] } = { source: [], target: [] },
): GeoAutoResult {
  const planes = findPlanes(matches, 0.004 * tgt.width, opts.planeMin, opts.maxPlanes)
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
        const rT = Math.max(3, rS * scale)
        const t = sampleDisc(tgt, b[0], b[1], rT)
        if (t.clipped || t.spread > opts.maxSpread) continue
        if (luminance(decodeRgb(s.rgb)) < 0.003 || luminance(decodeRgb(t.rgb)) < 0.003) continue
        cands.push({ a, b, ra: rS, rb: rT, plane: pi, flat: s.spread + t.spread, s, t })
      }
    }
  })

  // Skin from the face mesh: open-skin landmarks that face both cameras and
  // read flat and unclipped in both, in a disc sized to each face.
  const facePairs = pairFaces(faces.source, faces.target, planes)
  const skin: Candidate[] = []
  for (const [fa, fb] of facePairs) {
    const ra = Math.max(3, 0.1 * eyeSpan(fa))
    const rb = Math.max(3, 0.1 * eyeSpan(fb))
    const mine: Candidate[] = []
    for (const i of SKIN) {
      if (facing(fa, i) < 0.6 || facing(fb, i) < 0.6) continue
      const a = fa.pts[i]
      const b = fb.pts[i]
      const s = sampleDisc(src, a[0], a[1], ra)
      if (s.clipped || s.spread > opts.maxSpread) continue
      const t = sampleDisc(tgt, b[0], b[1], rb)
      if (t.clipped || t.spread > opts.maxSpread) continue
      mine.push({ a, b, ra, rb, plane: -1, flat: s.spread + t.spread, s, t })
    }
    skin.push(...pickVaried(mine.sort((p, q) => p.flat - q.flat), opts.perFace, 2 * ra))
  }

  // Per plane: as many colours as possible, kept apart from each other. The
  // flattest spot of a plane is usually its biggest plain area (the wall),
  // so choosing by flatness alone would fill every slot with one colour.
  // A face with a mesh gets its skin from the mesh alone: a plane only
  // approximates a head, and the face would be crowded with labels.
  const onFace = (p: Pt) =>
    facePairs.some(([fa]) => {
      const near = 0.15 * eyeSpan(fa)
      return fa.pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < near)
    })
  const minSep = 0.05 * src.width
  const quota = Math.max(opts.perPlane, Math.ceil((opts.maxPairs * 1.5) / Math.max(1, planes.length)))
  let chosen: Candidate[] = []
  planes.forEach((_, pi) => {
    const mine = cands.filter((c) => c.plane === pi && !(skin.length && onFace(c.a))).sort((p, q) => p.flat - q.flat)
    chosen.push(...pickVaried(mine, quota, minSep))
  })

  // Consensus check: a spot that landed on a different depth than its plane
  // reads a different object in the target, and its colours disagree with
  // what every other pair says the camera difference is. Skin pairs face it
  // too: a face paired with the wrong face disagrees the same way.
  chosen.push(...skin)
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

  const final = [
    ...chosen.filter((c) => c.plane < 0),
    ...pickVaried(chosen.filter((c) => c.plane >= 0).sort((p, q) => p.flat - q.flat), opts.maxPairs, 0),
  ]
  return {
    suggestions: final.map((c) => ({ source: { x: c.a[0], y: c.a[1], r: c.ra }, target: { x: c.b[0], y: c.b[1], r: c.rb }, plane: c.plane })),
    planes: planes.map((p) => ({ H: p.H, matches: p.members.length })),
    matches: matches.length,
    candidates: cands.length + skin.length,
    rejected,
    faces: facePairs.length,
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
