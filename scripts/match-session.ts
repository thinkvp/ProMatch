/**
 * Re-run the panel's saved session (%APPDATA%\ProMatch\session.json) offline:
 * same frames, same points, current engine. Prints per-point error and writes
 * a side-by-side "source | target after" PNG next to the captures.
 * Run: npx tsx scripts/match-session.ts [--no-contrast] [--global-only]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_OPTIONS, type MatchOptions, applyModel, fitMatch, reportPairs } from '../src/core/match.ts'
import { applyLutToPixels, bakeLut } from '../src/core/lut.ts'
import { sampleDisc } from '../src/core/sample.ts'
import { encodePng, readPng } from './png.ts'
import { pointRadius } from './session.ts'

const dir = join(process.env.APPDATA!, 'ProMatch')
const s = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))
const opts: MatchOptions = { ...DEFAULT_OPTIONS, ...s.opts }
if (process.argv.includes('--no-contrast')) opts.matchContrast = false
if (process.argv.includes('--global-only')) opts.localStrength = 0

const src = readPng(s.frames.source.path)
const tgt = readPng(s.frames.target.path)
const pairs = s.pairs.filter((p: any) => p.source && p.target)
const inputs = pairs.map((p: any) => ({
  source: sampleDisc(src, p.source.x, p.source.y, pointRadius(s, src.width, p.source)),
  target: sampleDisc(tgt, p.target.x, p.target.y, pointRadius(s, tgt.width, p.target)),
}))
const model = fitMatch(inputs, opts)
console.log(`source ${s.frames.source.label}  |  target ${s.frames.target.label}`)
console.log(`exposure ${model.exposureStops.toFixed(2)} st, contrast ${model.contrast.toFixed(3)}, matrix ${model.matrix.map((v) => v.toFixed(2)).join(' ')}`)
let sb = 0
let sa = 0
reportPairs(model, inputs).forEach((r, i) => {
  const c = (v: number[]) => v.map((x) => Math.round(x * 255)).join(',')
  console.log(`  #${i + 1}  src ${c(inputs[i].source.rgb)}  tgt ${c(inputs[i].target.rgb)}  -> ${c(r.matched)}   ΔE ${r.before.toFixed(1)} -> ${r.after.toFixed(1)}${r.used ? '' : `  (ignored: ${r.reason})`}`)
  sb += r.before
  sa += r.after
})
console.log(`  mean ΔE ${(sb / inputs.length).toFixed(2)} -> ${(sa / inputs.length).toFixed(2)}`)

// Side by side at half size: source | matched target.
const lut = bakeLut(33, (c) => applyModel(model, c))
const after = new Uint8ClampedArray(tgt.data)
applyLutToPixels(lut, after)
const W = 960
const H = Math.round((src.height * W) / src.width)
const out = new Uint8Array(W * 2 * H * 3)
const put = (img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }, ox: number) => {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.floor((x * img.width) / W)
      const sy = Math.floor((y * img.height) / H)
      const i = (sy * img.width + sx) * 4
      const o = (y * W * 2 + x + ox) * 3
      out[o] = img.data[i]
      out[o + 1] = img.data[i + 1]
      out[o + 2] = img.data[i + 2]
    }
  }
}
put(src, 0)
put({ width: tgt.width, height: tgt.height, data: after }, W)
const file = join(dir, 'captures', 'compare.png')
writeFileSync(file, encodePng(W * 2, H, out))
console.log(`wrote ${file}`)
