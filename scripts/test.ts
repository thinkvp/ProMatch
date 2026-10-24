/**
 * Engine tests against synthetic "second cameras" whose difference from the
 * first is known exactly, so "did the match undo it?" has a number for an
 * answer. Run: npm test
 */
import {
  type Vec3,
  decodeRgb,
  deltaE,
  encodedToOklab,
  luminance,
} from '../src/core/color.ts'
import { DEFAULT_OPTIONS, type MatchOptions, type PairInput, applyModel, crossValidate, disagreeing, fitMatch, reportPairs } from '../src/core/match.ts'
import { bakeLut, parseCube, parseEmbeddedText, sampleLut, sampleLutTetra, toCube, toEmbeddedText } from '../src/core/lut.ts'
import { sampleDisc } from '../src/core/sample.ts'
import { analyse } from '../src/core/analysis.ts'
import { convexHull, insidePolygon, lumaStats, pixelIndices, vectorscope, ycbcr } from '../src/core/scopes.ts'
import { suggestPairs } from '../src/core/auto.ts'
import { suggestFromMatches } from '../src/core/geo-auto.ts'
import { type Correspondence, type Homography, type Pt, applyH, findPlanes, ransacHomography } from '../src/core/homography.ts'
import { cameraB } from './synthetic.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

// Deterministic PRNG so the numbers in the output are stable run to run.
let seed = 12345
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

/** Plausible scene colours as camera A renders them: nothing clipped, nothing black. */
function sceneColours(n: number): Vec3[] {
  const out: Vec3[] = []
  while (out.length < n) {
    const c: Vec3 = [0.08 + rand() * 0.8, 0.08 + rand() * 0.8, 0.08 + rand() * 0.8]
    out.push(c)
  }
  return out
}

const sample = (rgb: Vec3) => ({ rgb, spread: 0, clipped: false })

function meanDE(pairs: Array<[Vec3, Vec3]>): number {
  return pairs.reduce((a, [x, y]) => a + deltaE(encodedToOklab(x), encodedToOklab(y)), 0) / pairs.length
}

function pairsFrom(colours: Vec3[], cam: (c: Vec3) => Vec3): PairInput[] {
  return colours.map((c) => ({ source: sample(c), target: sample(cam(c)) }))
}

function heldOutError(opts: MatchOptions, train: Vec3[], test: Vec3[], cam: (c: Vec3) => Vec3) {
  const model = fitMatch(pairsFrom(train, cam), opts)
  const before = meanDE(test.map((c) => [cam(c), c]))
  const after = meanDE(test.map((c) => [applyModel(model, cam(c)), c]))
  return { model, before, after }
}

// ---------------------------------------------------------------------------

{
  const cs = sceneColours(5)
  const model = fitMatch(cs.map((c) => ({ source: sample(c), target: sample(c) })))
  const test = sceneColours(200)
  const worst = Math.max(...test.map((c) => deltaE(encodedToOklab(applyModel(model, c)), encodedToOklab(c))))
  check('identical cameras -> identity', worst < 0.05, `worst ΔE ${worst.toFixed(4)}`)
}

{
  const model = fitMatch([])
  const c: Vec3 = [0.3, 0.6, 0.9]
  const o = applyModel(model, c)
  check('no pairs -> identity', deltaE(encodedToOklab(o), encodedToOklab(c)) < 1e-6)
}

{
  const cam = (c: Vec3) => cameraB(c, { exposure: -1, wb: [1, 1, 1], cross: 0, redShift: 0 })
  const r = heldOutError({ ...DEFAULT_OPTIONS, globalModel: 'exposure' }, [[0.5, 0.45, 0.4]], sceneColours(200).map((c) => c.map((v) => v * 0.8) as Vec3), cam)
  check('one pair recovers a pure exposure change', r.after < 0.3, `ΔE ${r.before.toFixed(2)} -> ${r.after.toFixed(3)}, ${r.model.exposureStops.toFixed(3)} stops`)
  check('  ...and reports it as +1 stop', Math.abs(r.model.exposureStops - 1) < 0.01)
}

{
  const cam = (c: Vec3) => cameraB(c, { redShift: 0 })
  const train = sceneColours(6)
  const test = sceneColours(300).map((c) => c.map((v) => v * 0.85) as Vec3)
  const ex = heldOutError({ ...DEFAULT_OPTIONS, globalModel: 'exposure', localStrength: 0 }, train, test, cam)
  const bal = heldOutError({ ...DEFAULT_OPTIONS, globalModel: 'balance', localStrength: 0 }, train, test, cam)
  const mat = heldOutError({ ...DEFAULT_OPTIONS, globalModel: 'matrix', localStrength: 0 }, train, test, cam)
  console.log(`      exposure+WB+crosstalk camera, 6 pairs, held-out ΔE: none ${ex.before.toFixed(2)} | exposure ${ex.after.toFixed(2)} | +balance ${bal.after.toFixed(2)} | +matrix ${mat.after.toFixed(2)}`)
  check('each global model improves on the simpler one', ex.after < ex.before && bal.after < ex.after && mat.after < bal.after)
  // Contrast matching is on by default; on a camera with no contrast
  // difference it fits a small spurious curve, which costs a little here.
  check('full matrix gets held-out colours close', mat.after < 2, `ΔE ${mat.after.toFixed(2)}`)
}

{
  // Real cameras differ in picture profile: a flatter camera lifts its darks.
  const cam = (c: Vec3) => cameraB(c, { redShift: 0, contrast: 0.75 })
  const train = sceneColours(6)
  const test = sceneColours(300).map((c) => c.map((v) => v * 0.85) as Vec3)
  const off = heldOutError({ ...DEFAULT_OPTIONS, matchContrast: false, localStrength: 0 }, train, test, cam)
  const on = heldOutError({ ...DEFAULT_OPTIONS, localStrength: 0 }, train, test, cam)
  console.log(`      flat-profile camera, held-out ΔE: none ${on.before.toFixed(2)} | no contrast stage ${off.after.toFixed(2)} | with contrast ${on.after.toFixed(2)}, contrast ${on.model.contrast.toFixed(3)} (true 1.333)`)
  check('contrast stage fixes a flatter picture profile', on.after < off.after * 0.75, `ΔE ${off.after.toFixed(2)} -> ${on.after.toFixed(2)}`)
  check('  ...and recovers the contrast difference', Math.abs(on.model.contrast - 1 / 0.75) < 0.08)
}

{
  // Two pairs: not enough to pin a 3x3 matrix. Ridge must keep it sane.
  const cam = (c: Vec3) => cameraB(c, { redShift: 0 })
  const test = sceneColours(300).map((c) => c.map((v) => v * 0.85) as Vec3)
  const two = heldOutError({ ...DEFAULT_OPTIONS, localStrength: 0 }, [[0.6, 0.55, 0.5], [0.3, 0.5, 0.25]], test, cam)
  check('two pairs: matrix fit still helps held-out colours', two.after < two.before * 0.5, `ΔE ${two.before.toFixed(2)} -> ${two.after.toFixed(2)}`)
}

{
  // The apple. Global layer alone cannot fix a hue-specific twist; local must.
  const cam = (c: Vec3) => cameraB(c)
  const apple: Vec3 = [0.75, 0.12, 0.1]
  const train: Vec3[] = [apple, [0.62, 0.6, 0.57], [0.3, 0.45, 0.6], [0.35, 0.55, 0.3], [0.85, 0.7, 0.55]]
  const pairs = pairsFrom(train, cam)
  const globalOnly = fitMatch(pairs, { ...DEFAULT_OPTIONS, localStrength: 0 })
  const full = fitMatch(pairs, DEFAULT_OPTIONS)
  const de = (m: typeof full, c: Vec3) => deltaE(encodedToOklab(applyModel(m, cam(c))), encodedToOklab(c))
  console.log(`      apple ΔE: uncorrected ${deltaE(encodedToOklab(cam(apple)), encodedToOklab(apple)).toFixed(2)} | global ${de(globalOnly, apple).toFixed(2)} | global+local ${de(full, apple).toFixed(2)}`)
  check('local layer nails the sampled apple', de(full, apple) < 1, `ΔE ${de(full, apple).toFixed(2)}`)
  const nearApple: Vec3 = [0.65, 0.1, 0.09] // darker side of the same apple
  check('  ...and the shadowed side of it', de(full, nearApple) < de(globalOnly, nearApple) * 0.6, `ΔE ${de(globalOnly, nearApple).toFixed(2)} -> ${de(full, nearApple).toFixed(2)}`)
  const sky: Vec3 = [0.4, 0.6, 0.85]
  const skyShift = deltaE(encodedToOklab(applyModel(full, cam(sky))), encodedToOklab(applyModel(globalOnly, cam(sky))))
  check('  ...without dragging unrelated colours around', skyShift < 1.5, `blue moved ΔE ${skyShift.toFixed(2)} by the local layer`)
  const rep = reportPairs(full, pairs)
  check('report: every pair improves', rep.every((r) => r.after <= r.before), rep.map((r) => `${r.before.toFixed(1)}->${r.after.toFixed(1)}`).join(' '))
}

{
  // Disagreeing pairs at nearly the same colour must not explode.
  const pairs: PairInput[] = [
    { source: sample([0.6, 0.3, 0.3]), target: sample([0.55, 0.3, 0.3]) },
    { source: sample([0.5, 0.35, 0.3]), target: sample([0.55, 0.31, 0.3]) },
  ]
  const model = fitMatch(pairs)
  const test = sceneColours(500)
  const worst = Math.max(...test.map((c) => deltaE(encodedToOklab(applyModel(model, c)), encodedToOklab(c))))
  check('conflicting near-duplicate pairs stay bounded', worst < 25, `worst move ΔE ${worst.toFixed(1)}`)
}

{
  const pairs: PairInput[] = [
    { source: { rgb: [1, 1, 1], spread: 0, clipped: true }, target: sample([0.7, 0.7, 0.7]) },
    { source: sample([0.5, 0.4, 0.3]), target: sample([0.4, 0.32, 0.24]) },
  ]
  const model = fitMatch(pairs)
  check('clipped pair is ignored and reported', model.used === 1 && model.ignored[0]?.reason === 'clipped')
}

{
  const cam = (c: Vec3) => cameraB(c, { redShift: 0 })
  const model = fitMatch(pairsFrom(sceneColours(6), cam), { ...DEFAULT_OPTIONS, autoExposure: false })
  check('auto exposure off keeps brightness', Math.abs(model.exposureStops) < 0.02, `${model.exposureStops.toFixed(3)} stops`)
}

{
  // Grey ramp must stay monotonic after a strong brighten (roll-off engaged).
  const cam = (c: Vec3) => cameraB(c, { exposure: -1.3, redShift: 0 })
  const model = fitMatch(pairsFrom(sceneColours(6).map((c) => c.map((v) => v * 0.6) as Vec3), cam))
  let ok = true
  let prev = -1
  for (let i = 0; i <= 255; i++) {
    const o = applyModel(model, [i / 255, i / 255, i / 255])
    const y = luminance(decodeRgb(o))
    if (y < prev - 1e-6) ok = false
    prev = y
  }
  check('grey ramp stays monotonic with roll-off', ok, `headroom ${model.headroom.toFixed(2)}`)
  const top = applyModel(model, [1, 1, 1])
  check('  ...and white lands at (not past) white', Math.max(...top) <= 1 && Math.min(...top) > 0.9, top.map((v) => v.toFixed(3)).join(' '))
  const mid = applyModel({ ...model, rolloff: false }, [0.4, 0.4, 0.4])
  const midR = applyModel(model, [0.4, 0.4, 0.4])
  check('  ...and roll-off leaves midtones alone', deltaE(encodedToOklab(mid), encodedToOklab(midR)) < 1e-6)
}

{
  const cam = (c: Vec3) => cameraB(c)
  const model = fitMatch(pairsFrom(sceneColours(6), cam))
  const lut = bakeLut(33, (c) => applyModel(model, c))
  const back = parseCube(toCube(lut, 'test', ['comment']))
  let maxDiff = 0
  for (let i = 0; i < lut.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(lut.data[i] - back.data[i]))
  check('.cube round-trips', back.size === 33 && maxDiff < 1e-6, `max diff ${maxDiff.toExponential(1)}`)
  let worst = 0
  const tmp: Vec3 = [0, 0, 0]
  for (const c of sceneColours(500)) {
    const exact = applyModel(model, c)
    sampleLut(lut, c[0], c[1], c[2], tmp)
    worst = Math.max(worst, deltaE(encodedToOklab(exact), encodedToOklab(tmp)))
  }
  check('33³ LUT reproduces the model', worst < 1.5, `worst interpolation ΔE ${worst.toFixed(2)}`)
  const id = bakeLut(17, (c) => c)
  sampleLut(id, 0.123, 0.456, 0.789, tmp)
  check('identity LUT samples exactly', Math.abs(tmp[0] - 0.123) + Math.abs(tmp[1] - 0.456) + Math.abs(tmp[2] - 0.789) < 1e-6)
  sampleLutTetra(id, 0.123, 0.456, 0.789, tmp)
  check('identity LUT samples exactly (tetrahedral)', Math.abs(tmp[0] - 0.123) + Math.abs(tmp[1] - 0.456) + Math.abs(tmp[2] - 0.789) < 1e-6)
  // The native effect and the preview interpolate tetrahedrally. A fixed grid
  // of colours, so the shared PRNG sequence (and later tests) stay unchanged.
  let worstTetra = 0
  for (let r = 0.1; r < 0.9; r += 0.07) {
    for (let g = 0.1; g < 0.9; g += 0.07) {
      for (let b = 0.1; b < 0.9; b += 0.07) {
        const c: Vec3 = [r, g, b]
        sampleLutTetra(lut, r, g, b, tmp)
        worstTetra = Math.max(worstTetra, deltaE(encodedToOklab(applyModel(model, c)), encodedToOklab(tmp)))
      }
    }
  }
  const embedded = toEmbeddedText(lut)
  const unpacked = parseEmbeddedText(embedded)!
  let embedDiff = 0
  for (let i = 0; i < lut.data.length; i++) embedDiff = Math.max(embedDiff, Math.abs(lut.data[i] - unpacked.data[i]))
  check('embedded LUT text round-trips', unpacked.size === 33 && embedDiff * 255 < 0.01, `max ${(embedDiff * 255).toFixed(4)}/255, ${(embedded.length / 1024).toFixed(0)} KB vs .cube ${(toCube(lut, 't').length / 1024).toFixed(0)} KB`)
  check('33³ LUT reproduces the model (tetrahedral)', worstTetra < 1.5, `worst interpolation ΔE ${worstTetra.toFixed(2)}`)
}

{
  // Patch with a specular glint and a dark seam: trimmed mean should ignore both.
  const w = 40
  const h = 40
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 180
    data[i * 4 + 1] = 40
    data[i * 4 + 2] = 30
    data[i * 4 + 3] = 255
  }
  for (const [x, y] of [[20, 20], [21, 20], [20, 21], [21, 21]]) data.set([255, 255, 255, 255], (y * w + x) * 4)
  for (let y = 10; y < 30; y++) data.set([5, 5, 5, 255], (y * w + 12) * 4)
  const s = sampleDisc({ width: w, height: h, data }, 20, 20, 9)
  const err = deltaE(encodedToOklab(s.rgb), encodedToOklab([180 / 255, 40 / 255, 30 / 255]))
  check('disc sample rejects glint and seam', err < 1, `ΔE ${err.toFixed(2)}, clipped=${s.clipped}`)
  check('  ...and is not flagged clipped', !s.clipped)
}

{
  // Auto on a synthetic room: blocks of colour, camera B framed tighter and
  // offset, with the full set of camera errors. No points given.
  const W = 480
  const H = 270
  const blocks: Array<[number, number, number, number, Vec3]> = [
    [0, 0, 1, 1, [0.55, 0.53, 0.5]], // wall
    [0.1, 0.15, 0.3, 0.45, [0.85, 0.72, 0.18]], // book
    [0.45, 0.2, 0.75, 0.7, [0.82, 0.6, 0.5]], // skin
    [0.4, 0.7, 0.8, 1, [0.18, 0.3, 0.55]], // shirt
    [0.15, 0.6, 0.32, 0.9, [0.75, 0.12, 0.1]], // apple
    [0.8, 0.4, 0.97, 0.8, [0.25, 0.48, 0.2]], // plant
  ]
  const scene = (u: number, v: number): Vec3 => {
    let c: Vec3 = blocks[0][4]
    for (const [u0, v0, u1, v1, col] of blocks) if (u >= u0 && u < u1 && v >= v0 && v < v1) c = col
    return c
  }
  const render = (cam: (c: Vec3) => Vec3, u0: number, v0: number, span: number) => {
    const data = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = cam(scene(u0 + (x / W) * span, v0 + (y / H) * span))
        data.set([Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255], (y * W + x) * 4)
      }
    }
    return { width: W, height: H, data }
  }
  const camB = (c: Vec3) => cameraB(c, { contrast: 0.8 })
  const src = render((c) => c, 0, 0, 1)
  const tgt = render(camB, 0.08, 0.05, 0.85)
  const sug = suggestPairs(analyse(src), analyse(tgt))
  const model = fitMatch(sug.map((g) => ({ source: sampleDisc(src, g.source.x, g.source.y, 3), target: sampleDisc(tgt, g.target.x, g.target.y, 3) })))
  const cols = blocks.map((b) => b[4])
  const before = meanDE(cols.map((c) => [camB(c), c]))
  const after = meanDE(cols.map((c) => [applyModel(model, camB(c)), c]))
  check('auto finds pairs with no clicks', sug.length >= 4, `${sug.length} suggestions`)
  check('  ...and they fix the scene colours', after < before * 0.3, `ΔE ${before.toFixed(2)} -> ${after.toFixed(2)}`)
}

{
  // Homography RANSAC: a zoomed, rotated, slightly perspective view, noisy
  // matches, plus 30% garbage.
  const H: Homography = [1.3, 0.08, -150, -0.06, 1.28, -60, 0.00004, -0.00002, 1]
  const good: Correspondence[] = []
  for (let i = 0; i < 70; i++) {
    const a: Pt = [100 + rand() * 1700, 80 + rand() * 900]
    const b = applyH(H, a)
    good.push({ a, b: [b[0] + (rand() - 0.5) * 0.8, b[1] + (rand() - 0.5) * 0.8] })
  }
  const junk: Correspondence[] = Array.from({ length: 30 }, () => ({ a: [rand() * 1920, rand() * 1080] as Pt, b: [rand() * 1920, rand() * 1080] as Pt }))
  const r = ransacHomography([...good, ...junk], 3)
  const found = r ? r.inliers.slice(0, 70).filter(Boolean).length : 0
  const junkIn = r ? r.inliers.slice(70).filter(Boolean).length : 99
  const worst = r ? Math.max(...good.map((c) => Math.hypot(applyH(r.H, c.a)[0] - applyH(H, c.a)[0], applyH(r.H, c.a)[1] - applyH(H, c.a)[1]))) : 99
  check('RANSAC homography recovers the true mapping', found >= 68 && junkIn <= 2 && worst < 1, `${found}/70 inliers, ${junkIn} junk, worst error ${worst.toFixed(2)} px`)

  // Two different planes (wall vs person at another depth) come out as two.
  const H2: Homography = [1.1, 0, 300, 0, 1.1, 40, 0, 0, 1]
  const other: Correspondence[] = Array.from({ length: 40 }, () => {
    const a: Pt = [500 + rand() * 400, 200 + rand() * 500]
    return { a, b: applyH(H2, a) }
  })
  const planes = findPlanes([...good, ...other, ...junk], 3)
  check('sequential RANSAC separates two planes', planes.length === 2 && planes[0].members.length >= 68 && planes[1].members.length >= 38, planes.map((p) => p.members.length).join(' + '))
}

{
  // Geometric Auto on a synthetic room seen through a known homography by
  // camera B. Matches are synthesised (no OpenCV), with junk mixed in.
  const W = 640
  const H = 360
  const blocks: Array<[number, number, number, number, Vec3]> = [
    [0, 0, 1, 1, [0.55, 0.53, 0.5]],
    [0.08, 0.12, 0.3, 0.42, [0.85, 0.72, 0.18]],
    [0.42, 0.18, 0.72, 0.66, [0.82, 0.6, 0.5]],
    [0.38, 0.7, 0.82, 1, [0.18, 0.3, 0.55]],
    [0.12, 0.58, 0.3, 0.88, [0.75, 0.12, 0.1]],
    [0.8, 0.36, 0.96, 0.8, [0.25, 0.48, 0.2]],
  ]
  const scene = (x: number, y: number): Vec3 => {
    const u = x / W
    const v = y / H
    let c: Vec3 = blocks[0][4]
    for (const [u0, v0, u1, v1, col] of blocks) if (u >= u0 && u < u1 && v >= v0 && v < v1) c = col
    return c
  }
  const camB = (c: Vec3) => cameraB(c, { contrast: 0.8 })
  // Target sees the scene zoomed 1.25x and shifted: target point = Hs(scene point).
  const Hs: Homography = [1.25, 0, -60, 0, 1.25, -30, 0, 0, 1]
  const Hinv: Homography = [0.8, 0, 48, 0, 0.8, 24, 0, 0, 1]
  const render = (map: (x: number, y: number) => Pt, cam: (c: Vec3) => Vec3) => {
    const data = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [sx, sy] = map(x + 0.5, y + 0.5)
        const c = cam(scene(sx, sy))
        data.set([Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255], (y * W + x) * 4)
      }
    }
    return { width: W, height: H, data }
  }
  const src = render((x, y) => [x, y], (c) => c)
  const tgt = render((x, y) => applyH(Hinv, [x, y]), camB)
  const matches: Correspondence[] = []
  for (let i = 0; i < 120; i++) {
    const a: Pt = [rand() * W, rand() * H]
    const b = applyH(Hs, a)
    if (b[0] > 0 && b[1] > 0 && b[0] < W && b[1] < H) matches.push({ a, b })
  }
  for (let i = 0; i < 30; i++) matches.push({ a: [rand() * W, rand() * H], b: [rand() * W, rand() * H] })
  const res = suggestFromMatches(matches, src, tgt)
  const mapErr = Math.max(...res.suggestions.map((g) => Math.hypot(applyH(Hs, [g.source.x, g.source.y])[0] - g.target.x, applyH(Hs, [g.source.x, g.source.y])[1] - g.target.y)))
  const flat = res.suggestions.every((g) => sampleDisc(src, g.source.x, g.source.y, 4).spread < 0.02)
  const model = fitMatch(res.suggestions.map((g) => ({ source: sampleDisc(src, g.source.x, g.source.y, 4), target: sampleDisc(tgt, g.target.x, g.target.y, 5) })))
  const cols = blocks.map((b) => b[4])
  const before = meanDE(cols.map((c) => [camB(c), c]))
  const after = meanDE(cols.map((c) => [applyModel(model, camB(c)), c]))
  check('geometric auto: pairs are the same physical spot', res.suggestions.length >= 5 && mapErr < 1.5, `${res.suggestions.length} pairs from ${res.planes.length} plane(s), worst ${mapErr.toFixed(2)} px off`)
  check('  ...on flat patches, not edges', flat)
  check('  ...and they fix the scene colours', after < before * 0.3, `ΔE ${before.toFixed(2)} -> ${after.toFixed(2)}`)
}

{
  // Tested error flags a pair the others disagree with (here: a "blurred"
  // background pick whose target colour belongs to a different surface).
  const cam = (c: Vec3) => cameraB(c, { redShift: 0 })
  const good = sceneColours(8)
  const pairs: PairInput[] = good.map((c) => ({ source: sample(c), target: sample(cam(c)) }))
  pairs.push({ source: sample([0.45, 0.44, 0.33]), target: sample(cam([0.62, 0.62, 0.6])) })
  const tested = crossValidate(pairs)!
  const flagged = disagreeing(pairs)
  check('tested error flags the odd pair out', flagged.length === 1 && flagged[0] === 8, `flagged ${flagged.map((i) => i + 1).join(',') || 'none'}; its tested error ${tested[8].toFixed(1)}`)
  check('  ...and needs 3 pairs to say anything', crossValidate(pairs.slice(0, 2)) === null)
}

{
  // Scopes: the maths a colourist would sanity-check.
  const [, cbR, crR] = ycbcr(255, 0, 0)
  check('vectorscope: red sits upper-left (Cb < 0, Cr = +0.5)', cbR < -0.1 && Math.abs(crR - 0.5) < 1e-9)
  const [yG, cbG, crG] = ycbcr(128, 128, 128)
  check('  ...and grey sits dead centre', Math.abs(cbG) < 1e-9 && Math.abs(crG) < 1e-9 && Math.abs(yG - 128 / 255) < 1e-9)
  // Luma ramp 0..255 across 256 pixels: percentiles land where they should.
  const ramp = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i++) ramp.set([i, i, i, 255], i * 4)
  const st = lumaStats(ramp, pixelIndices(256, 1, 1))
  check('luma percentiles on a ramp', Math.abs(st.p05 - 5) <= 1 && Math.abs(st.p50 - 50) <= 1 && Math.abs(st.p95 - 95) <= 1, `${st.p05} / ${st.p50} / ${st.p95}`)
  const v = vectorscope(ramp, pixelIndices(256, 1, 1), 64, 2)
  check('  ...and a grey ramp is one dot in the vectorscope', v.counts[32 * 64 + 32] === 256)
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 8]])
  check('convex hull drops interior points', hull.length === 4 && insidePolygon(hull, 5, 5) && !insidePolygon(hull, 11, 5))
}

{
  // "Exposure only" must not change colour, even with the per-colour layer at 100%:
  // the camera here differs in white balance and reds as well as exposure.
  const cam = (c: Vec3) => cameraB(c)
  const train = sceneColours(10)
  const model = fitMatch(pairsFrom(train, cam), { ...DEFAULT_OPTIONS, globalModel: 'exposure', localStrength: 1 })
  let worst = 0
  for (const c of sceneColours(200)) {
    const t = cam(c)
    const [L0, a0, b0] = encodedToOklab(t)
    const [L1, a1, b1] = encodedToOklab(applyModel(model, t))
    if (L0 < 0.15 || L1 < 0.15 || L1 > 0.95) continue
    // Hue angle and chroma relative to lightness: what "colour" means once brightness changes.
    const dh = Math.abs(Math.atan2(b1, a1) - Math.atan2(b0, a0)) * (Math.hypot(a0, b0) > 0.02 ? 1 : 0)
    const dr = Math.abs(Math.hypot(a1, b1) / L1 - Math.hypot(a0, b0) / L0)
    worst = Math.max(worst, dr + Math.min(dh, 2 * Math.PI - dh) * 0.1)
  }
  check('Exposure-only model leaves hue and saturation alone (per-colour at 100%)', worst < 0.02, `worst colour change ${worst.toFixed(4)}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
