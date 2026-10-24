/**
 * Same-frame check of the native ProMatch effect inside Premiere (spike P7):
 * a capture without the effect, a capture with it, and the .cube it used.
 * Premiere's result is compared with the LUT applied in software
 * (applyLutToPixels, i.e. the panel's After view), overall and by brightness.
 *   npx tsx scripts/effect-compare.ts before.png after.png lut.cube [amount=1]
 */
import { readFileSync } from 'node:fs'
import { applyLutToPixels, parseCube } from '../src/core/lut.ts'
import { readPng } from './png.ts'

const [beforePath, afterPath, cubePath, amountArg] = process.argv.slice(2)
if (!cubePath) {
  console.error('usage: effect-compare.ts before.png after.png lut.cube [amount]')
  process.exit(2)
}
const amount = amountArg === undefined ? 1 : parseFloat(amountArg)
const before = readPng(beforePath)
const after = readPng(afterPath)
if (before.width !== after.width || before.height !== after.height) throw new Error('frame sizes differ')

const predicted = new Uint8ClampedArray(before.data)
applyLutToPixels(parseCube(readFileSync(cubePath, 'utf8')), predicted)
if (amount !== 1) {
  for (let i = 0; i < predicted.length; i++) predicted[i] = Math.round(before.data[i] + (predicted[i] - before.data[i]) * amount)
}

function stats(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sum = 0
  let max = 0
  let over1 = 0
  let over3 = 0
  let n = 0
  const bands = [0, 0, 0, 0, 0].map(() => ({ sum: 0, n: 0 }))
  for (let i = 0; i < a.length; i += 4) {
    const luma = (before.data[i] + before.data[i + 1] + before.data[i + 2]) / 3
    const band = bands[Math.min(4, Math.floor(luma / 51.2))]
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c])
      sum += d
      max = Math.max(max, d)
      if (d > 1) over1++
      if (d > 3) over3++
      band.sum += d
      band.n++
      n++
    }
  }
  return {
    mean: +(sum / n).toFixed(3),
    max,
    over1Pct: +((100 * over1) / n).toFixed(2),
    over3Pct: +((100 * over3) / n).toFixed(3),
    byBrightness: bands.map((x) => (x.n ? +(x.sum / x.n).toFixed(3) : null)),
  }
}

console.log(`before ${beforePath}\nafter  ${afterPath}\nLUT    ${cubePath}, amount ${amount}`)
console.log('effect size, before vs after:        ', stats(before.data, after.data))
console.log('Premiere vs software (panel After):   ', stats(after.data, predicted))
