/**
 * Planar homographies between the two camera views: fit (normalised DLT,
 * least squares) and robust fit (RANSAC). Kept here rather than in OpenCV so
 * the geometry is testable under plain Node and only feature detection
 * needs the 11 MB library.
 */
import { solve } from './linalg.ts'

export type Pt = [number, number]
/** Row-major 3x3. */
export type Homography = number[]

export interface Correspondence {
  a: Pt
  b: Pt
}

export function applyH(H: Homography, p: Pt): Pt {
  const w = H[6] * p[0] + H[7] * p[1] + H[8]
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w]
}

function mul3(A: number[], B: number[]): number[] {
  const out = new Array<number>(9).fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c]
  return out
}

/** Similarity transform taking points to zero mean, mean distance √2 (Hartley). */
function normaliser(ps: Pt[]): { T: number[]; Tinv: number[] } {
  let mx = 0
  let my = 0
  for (const p of ps) {
    mx += p[0]
    my += p[1]
  }
  mx /= ps.length
  my /= ps.length
  let d = 0
  for (const p of ps) d += Math.hypot(p[0] - mx, p[1] - my)
  const s = Math.SQRT2 / Math.max(d / ps.length, 1e-9)
  return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], Tinv: [1 / s, 0, mx, 0, 1 / s, my, 0, 0, 1] }
}

/** Least-squares homography (h33 = 1) from ≥ 4 correspondences; null if degenerate. */
export function fitHomography(cs: Correspondence[]): Homography | null {
  if (cs.length < 4) return null
  const na = normaliser(cs.map((c) => c.a))
  const nb = normaliser(cs.map((c) => c.b))
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0))
  const Atb: number[][] = Array.from({ length: 8 }, () => [0])
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i][0] += row[i] * rhs
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]
    }
  }
  for (const c of cs) {
    const [x, y] = applyH(na.T, c.a)
    const [u, v] = applyH(nb.T, c.b)
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u)
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v)
  }
  let h: number[][]
  try {
    h = solve(AtA, Atb)
  } catch {
    return null
  }
  const Hn = [h[0][0], h[1][0], h[2][0], h[3][0], h[4][0], h[5][0], h[6][0], h[7][0], 1]
  const H = mul3(nb.Tinv, mul3(Hn, na.T))
  const k = H[8]
  if (!Number.isFinite(k) || Math.abs(k) < 1e-12) return null
  return H.map((v) => v / k)
}

export function reprojectionError(H: Homography, c: Correspondence): number {
  const q = applyH(H, c.a)
  return Math.hypot(q[0] - c.b[0], q[1] - c.b[1])
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** RANSAC homography. `threshold` is the inlier reprojection error in target pixels. */
export function ransacHomography(
  cs: Correspondence[],
  threshold: number,
  iterations = 1500,
  seed = 7,
): { H: Homography; inliers: boolean[] } | null {
  if (cs.length < 4) return null
  const rand = rng(seed)
  let best: boolean[] | null = null
  let bestCount = 0
  for (let it = 0; it < iterations; it++) {
    const pick = new Set<number>()
    while (pick.size < 4) pick.add(Math.floor(rand() * cs.length))
    const H = fitHomography([...pick].map((i) => cs[i]))
    if (!H) continue
    const inl = cs.map((c) => reprojectionError(H, c) < threshold)
    const n = inl.filter(Boolean).length
    if (n > bestCount) {
      bestCount = n
      best = inl
    }
  }
  if (!best || bestCount < 4) return null
  // Refit on all inliers, then re-select with the refined model.
  let H = fitHomography(cs.filter((_, i) => best![i]))
  if (!H) return null
  let inliers = cs.map((c) => reprojectionError(H!, c) < threshold)
  const H2 = fitHomography(cs.filter((_, i) => inliers[i]))
  if (H2) {
    H = H2
    inliers = cs.map((c) => reprojectionError(H!, c) < threshold)
  }
  return { H, inliers }
}

/**
 * Peel off consistent planes one at a time: the scene is not one plane (the
 * person is in front of the wall, and the cameras are in different places),
 * but each part of it is close to one.
 */
export function findPlanes(
  cs: Correspondence[],
  threshold: number,
  minInliers = 20,
  maxPlanes = 4,
): Array<{ H: Homography; members: Correspondence[] }> {
  const planes: Array<{ H: Homography; members: Correspondence[] }> = []
  let left = cs
  for (let g = 0; g < maxPlanes && left.length >= minInliers; g++) {
    const r = ransacHomography(left, threshold, 1500, 7 + g)
    if (!r) break
    const members = left.filter((_, i) => r.inliers[i])
    if (members.length < minInliers) break
    planes.push({ H: r.H, members })
    left = left.filter((_, i) => !r.inliers[i])
  }
  return planes
}
