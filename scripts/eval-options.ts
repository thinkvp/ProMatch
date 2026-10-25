/**
 * Are the Settings defaults right, and does each switch do anything? Scores
 * match options on the saved real sessions, always on points the fit did NOT
 * see:
 *   - tested: leave-one-out over the session's own manual points
 *   - dense:  fitted on all the manual points, scored on a few hundred
 *             same-physical-spot pairs found by feature matching (flat spots
 *             on matched planes: wall, picture, sofa, shirt), away from the
 *             manual points. Many more colours and places than any point set.
 *   - effect: how much the option changes the whole matched frame compared
 *             with the defaults (mean ΔE over every pixel) — "does it do anything?"
 * Run: npx tsx scripts/eval-options.ts
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { deltaE, encodedToOklab, type Vec3 } from '../src/core/color.ts'
import { matchFeatures, readyCv } from '../src/core/features.ts'
import { suggestFromMatches } from '../src/core/geo-auto.ts'
import { applyLutToPixels, bakeLut } from '../src/core/lut.ts'
import { DEFAULT_OPTIONS, type MatchOptions, type PairInput, applyModel, fitMatch } from '../src/core/match.ts'
import { sampleDisc } from '../src/core/sample.ts'
import { readPng } from './png.ts'
import { pointRadius } from './session.ts'

const cv = await readyCv(createRequire(import.meta.url)('@techstark/opencv-js'))
const dir = join(process.env.APPDATA!, 'ProMatch')
// Every saved test case (the panel's "Save as test case"), or EVAL_FILES=a.json,b.json under %APPDATA%\ProMatch.
const files = process.env.EVAL_FILES?.split(',') ?? readdirSync(join(dir, 'eval')).filter((f) => f.endsWith('.json')).map((f) => `eval/${f}`)

interface Set {
  name: string
  manual: PairInput[]
  dense: PairInput[]
  target: { width: number; height: number; data: Uint8ClampedArray }
}

const sets: Set[] = []
for (const f of files) {
  const s = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const src = readPng(s.frames.source.path)
  const tgt = readPng(s.frames.target.path)
  const pts = s.pairs.filter((p: any) => p.source && p.target && !p.auto && !p.off)
  const manual: PairInput[] = pts.map((p: any) => ({
    source: sampleDisc(src, p.source.x, p.source.y, pointRadius(s, src.width, p.source)),
    target: sampleDisc(tgt, p.target.x, p.target.y, pointRadius(s, tgt.width, p.target)),
  }))
  const geo = suggestFromMatches(matchFeatures(cv, src, tgt), src, tgt, { maxPairs: 400, perPlane: 400, gridStep: 1 / 96, maxSpread: 0.03, reach: 0.06, support: 3, planeMin: 20, maxPlanes: 4, perFace: 0 })
  const away = 0.04 * src.width
  const r = Math.max(5, src.width / 160)
  const dense = geo.suggestions
    .filter((g) => pts.every((p: any) => Math.hypot(p.source.x - g.source.x, p.source.y - g.source.y) > away))
    .map((g) => ({ source: sampleDisc(src, g.source.x, g.source.y, r), target: sampleDisc(tgt, g.target.x, g.target.y, r) }))
  sets.push({ name: `${f.replace(/^eval\//, '').replace(/\.json$/, '')} (${manual.length} pts, ${dense.length} dense)`, manual, dense, target: tgt as any })
}

const err = (opts: MatchOptions | null, fit: PairInput[], p: PairInput) => {
  const m = opts ? fitMatch(fit, opts) : null
  return deltaE(encodedToOklab(m ? applyModel(m, p.target.rgb) : p.target.rgb), encodedToOklab(p.source.rgb))
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)
const pct = (v: number[], q: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(q * v.length))]

function tested(set: Set, opts: MatchOptions | null): number {
  return mean(set.manual.map((p, i) => err(opts, set.manual.filter((_, j) => j !== i), p)))
}

function dense(set: Set, opts: MatchOptions | null): number[] {
  const m = opts ? fitMatch(set.manual, opts) : null
  return set.dense.map((p) => deltaE(encodedToOklab(m ? applyModel(m, p.target.rgb) : p.target.rgb), encodedToOklab(p.source.rgb)))
}

/** The whole target frame matched with these options, every 4th pixel. */
function matchedFrame(set: Set, opts: MatchOptions): Float32Array {
  const lut = bakeLut(33, (c) => applyModel(fitMatch(set.manual, opts), c))
  const px = new Uint8ClampedArray(set.target.data)
  applyLutToPixels(lut, px)
  const out: number[] = []
  for (let i = 0; i < px.length; i += 16) out.push(...encodedToOklab([px[i] / 255, px[i + 1] / 255, px[i + 2] / 255]))
  return Float32Array.from(out)
}
const baseFrames = new Map<Set, Float32Array>()
function effect(set: Set, opts: MatchOptions): number {
  if (!baseFrames.has(set)) baseFrames.set(set, matchedFrame(set, DEFAULT_OPTIONS))
  const a = baseFrames.get(set)!
  const b = matchedFrame(set, opts)
  let sum = 0
  for (let i = 0; i < a.length; i += 3) sum += deltaE([a[i], a[i + 1], a[i + 2]] as Vec3, [b[i], b[i + 1], b[i + 2]] as Vec3)
  return sum / (a.length / 3)
}

const D = DEFAULT_OPTIONS
const configs: Array<[string, MatchOptions | null]> = [
  ['no correction', null],
  ['DEFAULTS', D],
  ['model: exposure', { ...D, globalModel: 'exposure' }],
  ['model: matrix', { ...D, globalModel: 'matrix' }],
  ['old defaults (matrix, range 0.12, smoothing 0.03)', { ...D, globalModel: 'matrix', colourRange: 0.12, smoothing: 0.03 }],
  ['match contrast off', { ...D, matchContrast: false }],
  ['match exposure off', { ...D, autoExposure: false }],
  ['roll-off off', { ...D, highlightRolloff: false }],
  ['per-colour 0% · exposure', { ...D, globalModel: 'exposure', localStrength: 0 }],
  ['per-colour 0% · balance', { ...D, globalModel: 'balance', localStrength: 0 }],
  ['per-colour 0% · matrix', { ...D, globalModel: 'matrix', localStrength: 0 }],
  ['per-colour 50%', { ...D, localStrength: 0.5 }],
  ['ridge 0.05', { ...D, matrixRidge: 0.05 }],
  ['ridge 0.5', { ...D, matrixRidge: 0.5 }],
  ['ridge 2', { ...D, matrixRidge: 2 }],
  ['colour range 0.06', { ...D, colourRange: 0.06 }],
  ['colour range 0.1', { ...D, colourRange: 0.1 }],
  ['colour range 0.2', { ...D, colourRange: 0.2 }],
  ['colour range 0.3', { ...D, colourRange: 0.3 }],
  ['smoothing 0.01', { ...D, smoothing: 0.01 }],
  ['smoothing 0.03', { ...D, smoothing: 0.03 }],
  ['smoothing 0.3', { ...D, smoothing: 0.3 }],
  ['shade spread 0', { ...D, shadeSpread: 0 }],
  ['shade spread 1', { ...D, shadeSpread: 1 }],
]

console.log('ΔE (Oklab x100), lower is better. tested = leave-one-out on your points; dense = mean / p90 on same-spot pairs the fit never saw; effect = change vs defaults over the whole frame.\n')
for (const set of sets) {
  console.log(set.name)
  console.log('  option                                        tested   dense  p90    effect')
  for (const [name, opts] of configs) {
    const d = dense(set, opts)
    const e = opts ? effect(set, opts).toFixed(2) : '   - '
    console.log(`  ${name.padEnd(44)} ${tested(set, opts).toFixed(2).padStart(6)}  ${mean(d).toFixed(2).padStart(6)} ${pct(d, 0.9).toFixed(1).padStart(5)}   ${e}`)
  }
  console.log()
}
