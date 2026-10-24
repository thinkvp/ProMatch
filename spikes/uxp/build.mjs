/*
 * Builds what the UXP spike loads besides its own files:
 *   - core.js: src/core (match + LUT) as a global PMCore, so the spike runs
 *     the real engine;
 *   - lut-invert.txt: a 33³ colour-invert LUT as the effect's embedded text,
 *     made here with Node's btoa so test 4 doesn't depend on UXP having it;
 *   - vendor/opencv.js: a copy of OpenCV.js, for the WebAssembly test.
 * Run: node spikes/uxp/build.mjs
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const dir = 'spikes/uxp'
await build({
  stdin: {
    contents: `export { fitMatch, applyModel, DEFAULT_OPTIONS } from './src/core/match.ts'
export { bakeLut, toEmbeddedText } from './src/core/lut.ts'`,
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: 'PMCore',
  target: 'es2020',
  outfile: `${dir}/core.js`,
  logLevel: 'info',
})

const { bakeLut, toEmbeddedText } = await import('../../src/core/lut.ts').catch(async () => {
  // Plain node can't import .ts: bundle it on the fly.
  const r = await build({ entryPoints: ['src/core/lut.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
})
writeFileSync(`${dir}/lut-invert.txt`, toEmbeddedText(bakeLut(33, ([r, g, b]) => [1 - r, 1 - g, 1 - b])))
mkdirSync(`${dir}/vendor`, { recursive: true })
copyFileSync('vendor/opencv.js', `${dir}/vendor/opencv.js`)
console.log('lut-invert.txt and vendor/opencv.js written')
