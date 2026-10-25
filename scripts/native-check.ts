/**
 * Checks the native effect's LUT engine (native/src/lut_engine.cpp, through
 * the lutapply test tool) against the panel's software LUT (src/core/lut.ts)
 * on a real frame, 8-bit and float paths, full and half Amount.
 *   npx tsx scripts/native-check.ts [frame.png] [lut.cube]
 * Build the tool first: cmake --build native/build --config Release --target lutapply
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Lut3D, applyLutToPixels, parseCube, toEmbeddedText } from '../src/core/lut.ts'
import { readPng } from './png.ts'

const spikes = join(process.env.APPDATA ?? '', 'ProMatch', 'spikes')
const framePath = process.argv[2] ?? join(spikes, 'lutasset-before-1792796174334.png')
const cubePath = process.argv[3] ?? join(spikes, 'lutasset-test.cube')
const tool = join(import.meta.dirname, '..', 'native', 'build', 'bin', 'Release', 'lutapply.exe')

const img = readPng(framePath)
const lut = parseCube(readFileSync(cubePath, 'utf8'))
const { width, height } = img

/** Reference tetrahedral lookup (same case split as the C++). */
function tetra(l: Lut3D, rgb: number[]): number[] {
  const n = l.size - 1
  const f: number[] = []
  const i0: number[] = []
  for (let c = 0; c < 3; c++) {
    const x = Math.min(Math.max(rgb[c], 0), 1) * n
    const k = Math.min(Math.floor(x), n - 1)
    i0.push(k)
    f.push(x - k)
  }
  const [dr, dg, db] = f
  const sr = 3
  const sg = l.size * 3
  const sb = l.size * l.size * 3
  const o = i0[2] * sb + i0[1] * sg + i0[0] * sr
  let a: number, b: number, w: number[]
  if (dr > dg) {
    if (dg > db) [a, b, w] = [sr, sr + sg, [1 - dr, dr - dg, dg - db, db]]
    else if (dr > db) [a, b, w] = [sr, sr + sb, [1 - dr, dr - db, db - dg, dg]]
    else [a, b, w] = [sb, sr + sb, [1 - db, db - dr, dr - dg, dg]]
  } else if (db > dg) [a, b, w] = [sb, sg + sb, [1 - db, db - dg, dg - dr, dr]]
  else if (db > dr) [a, b, w] = [sg, sg + sb, [1 - dg, dg - db, db - dr, dr]]
  else [a, b, w] = [sg, sr + sg, [1 - dg, dg - dr, dr - db, db]]
  const d = l.data
  return [0, 1, 2].map((c) => w[0] * d[o + c] + w[1] * d[o + a + c] + w[2] * d[o + b + c] + w[3] * d[o + sr + sg + sb + c])
}

function blend(src: Uint8Array | Uint8ClampedArray, full: Uint8Array | Uint8ClampedArray, amount: number): Uint8Array {
  // Blend in float before quantising, like the effect does.
  const out = new Uint8Array(src.length)
  for (let i = 0; i < src.length; i++) {
    out[i] = (i & 3) === 3 ? src[i] : Math.round(src[i] + (full[i] - src[i]) * amount)
  }
  return out
}

function stats(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sum = 0
  let max = 0
  let over1 = 0
  let n = 0
  for (let i = 0; i < a.length; i++) {
    if ((i & 3) === 3) continue
    const d = Math.abs(a[i] - b[i])
    sum += d
    max = Math.max(max, d)
    if (d > 1) over1++
    n++
  }
  return { mean: +(sum / n).toFixed(3), max, over1Pct: +((100 * over1) / n).toFixed(3) }
}

const dir = mkdtempSync(join(tmpdir(), 'pm-native-'))
const inRaw = join(dir, 'in.rgba')
writeFileSync(inRaw, img.data)

function native(amount: number, f32: boolean): { px: Uint8Array; info: string } {
  const out = join(dir, `out-${amount}-${f32}.rgba`)
  const info = execFileSync(tool, [cubePath, inRaw, out, String(width), String(height), String(amount), ...(f32 ? ['f32'] : [])], { encoding: 'utf8' }).trim()
  return { px: new Uint8Array(readFileSync(out)), info }
}

// Software references at Amount 1.
const trilinear = new Uint8ClampedArray(img.data)
applyLutToPixels(lut, trilinear)
const tetraRef = new Uint8Array(img.data.length)
for (let i = 0; i < img.data.length; i += 4) {
  const o = tetra(lut, [img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255])
  for (let c = 0; c < 3; c++) tetraRef[i + c] = Math.min(255, Math.max(0, Math.round(o[c] * 255)))
  tetraRef[i + 3] = img.data[i + 3]
}

console.log(`frame ${framePath} (${width}×${height}), LUT ${cubePath} (${lut.size}³)`)
console.log('LUT effect size, original vs trilinear:', stats(img.data, trilinear))
for (const f32 of [false, true]) {
  for (const amount of [1, 0.5]) {
    const { px, info } = native(amount, f32)
    const label = `native ${f32 ? 'f32' : '8u '} amount ${amount}`
    // Tetra reference blended with the 8-bit result: allow 1 for double rounding.
    const ref = amount === 1 ? tetraRef : blend(img.data, tetraRef, amount)
    const tri = amount === 1 ? trilinear : blend(img.data, trilinear, amount)
    console.log(label, info, '\n  vs tetra reference:', stats(px, ref), '\n  vs panel trilinear:', stats(px, tri))
  }
}

// The effect's embedded-LUT parameter: decode the panel's text in C++.
const embeddedPath = join(dir, 'embedded.txt')
writeFileSync(embeddedPath, toEmbeddedText(lut, 4242, 'ProMatch – C0779 (A)'))
console.log('embedded text, decoded by the effect:', execFileSync(tool, ['--embedded', cubePath, embeddedPath], { encoding: 'utf8' }).trim())
