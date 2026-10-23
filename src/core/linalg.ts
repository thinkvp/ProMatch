/**
 * Solve A·X = B for a small dense square A (Gaussian elimination with partial
 * pivoting). A is n×n, B is n×k. Inputs are not modified.
 *
 * The systems here are at most "number of point pairs" in size, so there is
 * nothing to gain from anything cleverer.
 */
export function solve(A: number[][], B: number[][]): number[][] {
  const n = A.length
  const k = B[0]?.length ?? 0
  const M = A.map((row, i) => [...row, ...B[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    }
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('singular system')
    if (piv !== col) [M[piv], M[col]] = [M[col], M[piv]]
    const p = M[col][col]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / p
      if (f === 0) continue
      for (let c = col; c < n + k; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row, i) => row.slice(n).map((v) => v / M[i][i]))
}
