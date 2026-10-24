/**
 * Grid search over the main match options on the saved real sessions, scored
 * like eval-options.ts (tested = leave-one-out on the manual points, dense =
 * same-spot pairs the fit never saw). Prints the best combinations by the
 * average of both scores over every session, each session weighted equally.
 * Run: npx tsx scripts/eval-grid.ts
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { deltaE, encodedToOklab } from '../src/core/color.ts'
import { matchFeatures, readyCv } from '../src/core/features.ts'
import { suggestFromMatches } from '../src/core/geo-auto.ts'
import { DEFAULT_OPTIONS, type GlobalModel, type MatchOptions, type PairInput, applyModel, fitMatch } from '../src/core/match.ts'
import { sampleDisc } from '../src/core/sample.ts'
import { readPng } from './png.ts'
import { pointRadius } from './session.ts'

const cv = await readyCv(createRequire(import.meta.url)('@techstark/opencv-js'))
const dir = join(process.env.APPDATA!, 'ProMatch')
// Every saved test case (the panel's "Save as test case"), or EVAL_FILES=a.json,b.json under %APPDATA%\ProMatch.
const files = process.env.EVAL_FILES?.split(',') ?? readdirSync(join(dir, 'eval')).filter((f) => f.endsWith('.json')).map((f) => `eval/${f}`)

const sets = files.map((f) => {
  const s = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const src = readPng(s.frames.source.path)
  const tgt = readPng(s.frames.target.path)
  const pts = s.pairs.filter((p: any) => p.source && p.target && !p.auto && !p.off)
  const manual: PairInput[] = pts.map((p: any) => ({
    source: sampleDisc(src, p.source.x, p.source.y, pointRadius(s, src.width, p.source)),
    target: sampleDisc(tgt, p.target.x, p.target.y, pointRadius(s, tgt.width, p.target)),
  }))
  const geo = suggestFromMatches(matchFeatures(cv, src, tgt), src, tgt, { maxPairs: 400, perPlane: 400, gridStep: 1 / 96, maxSpread: 0.03, reach: 0.06, support: 3 })
  const r = Math.max(5, src.width / 160)
  const dense = geo.suggestions
    .filter((g) => pts.every((p: any) => Math.hypot(p.source.x - g.source.x, p.source.y - g.source.y) > 0.04 * src.width))
    .map((g) => ({ source: sampleDisc(src, g.source.x, g.source.y, r), target: sampleDisc(tgt, g.target.x, g.target.y, r) }))
  return { name: f, manual, dense }
})

const e = (m: ReturnType<typeof fitMatch>, p: PairInput) => deltaE(encodedToOklab(applyModel(m, p.target.rgb)), encodedToOklab(p.source.rgb))
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
const score = (o: MatchOptions) =>
  sets.map((s) => {
    const tested = mean(s.manual.map((p, i) => e(fitMatch(s.manual.filter((_, j) => j !== i), o), p)))
    const m = fitMatch(s.manual, o)
    return [tested, mean(s.dense.map((p) => e(m, p)))]
  })

const rows: Array<{ label: string; t: number; d: number; per: number[][] }> = []
for (const globalModel of ['exposure', 'balance', 'matrix'] as GlobalModel[])
  for (const matchContrast of [true, false])
    for (const localStrength of [0, 0.5, 0.75, 1])
      for (const colourRange of localStrength ? [0.12, 0.15, 0.2, 0.3] : [0.15])
        for (const smoothing of localStrength ? [0.03, 0.1, 0.3] : [0.1])
          for (const shadeSpread of localStrength ? [0.5, 1] : [0.5]) {
            const o = { ...DEFAULT_OPTIONS, globalModel, matchContrast, localStrength, colourRange, smoothing, shadeSpread }
            const per = score(o)
            rows.push({
              label: `${globalModel.padEnd(8)} contrast ${matchContrast ? 'on ' : 'off'} local ${String(localStrength).padEnd(4)} range ${colourRange.toFixed(2)} smooth ${smoothing.toFixed(2)} shade ${shadeSpread}`,
              t: mean(per.map((p) => p[0])),
              d: mean(per.map((p) => p[1])),
              per,
            })
          }
const fmt = (r: (typeof rows)[0]) => `${r.label}   tested ${r.t.toFixed(2)}  dense ${r.d.toFixed(2)}  both ${((r.t + r.d) / 2).toFixed(2)}   [${r.per.map((p) => p.map((v) => v.toFixed(1)).join('/')).join('  ')}]`
const D = DEFAULT_OPTIONS
const def = rows.find((r) => r.label.startsWith(`${D.globalModel.padEnd(8)} contrast on  local ${String(D.localStrength).padEnd(4)} range ${D.colourRange.toFixed(2)} smooth ${D.smoothing.toFixed(2)} shade ${D.shadeSpread}`))
console.log(`${rows.length} combinations. Default:\n  ${def ? fmt(def) : '(not on the grid)'}\nBest by both:`)
for (const r of [...rows].sort((a, b) => a.t + a.d - (b.t + b.d)).slice(0, 15)) console.log(`  ${fmt(r)}`)
console.log('Best per model (both):')
for (const gm of ['exposure', 'balance', 'matrix']) console.log(`  ${fmt([...rows].filter((r) => r.label.startsWith(gm)).sort((a, b) => a.t + a.d - (b.t + b.d))[0])}`)
