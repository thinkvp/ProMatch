/*
 * Bundle src/panel/main.ts -> dist/panel.js as a single classic script.
 *
 * Same constraints as Interviewed (measured there on this machine):
 *   - CEP's CEF is Chromium 99, so target chrome99.
 *   - CEP's Node is ~16.13; builtins come from --enable-nodejs --mixed-context
 *     and must stay external so `require()` survives to runtime.
 *   - iife, not esm: Chromium's module loader is unreliable from file://.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { build, context } from 'esbuild'

// OpenCV.js is not bundled (11 MB): it ships next to the panel and is loaded
// only when Auto runs (src/panel/opencv.ts).
const OPENCV_SRC = 'node_modules/@techstark/opencv-js/dist/opencv.js'
const OPENCV_DST = 'vendor/opencv.js'
if (existsSync(OPENCV_SRC) && (!existsSync(OPENCV_DST) || statSync(OPENCV_DST).mtimeMs < statSync(OPENCV_SRC).mtimeMs)) {
  mkdirSync('vendor', { recursive: true })
  copyFileSync(OPENCV_SRC, OPENCV_DST)
  console.log(`[esbuild] copied ${OPENCV_SRC} -> ${OPENCV_DST}`)
}

const BARE_BUILTINS = ['fs', 'path', 'os', 'child_process']
const NODE_BUILTINS = [...BARE_BUILTINS, ...BARE_BUILTINS.map((m) => `node:${m}`)]

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/panel/main.ts'],
  outfile: 'dist/panel.js',
  bundle: true,
  format: 'iife',
  platform: 'node',
  target: ['chrome99', 'node16'],
  external: NODE_BUILTINS,
  sourcemap: 'linked',
  logLevel: 'info',
  minify: false,
  charset: 'utf8',
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('[esbuild] watching src/ — reload the panel to pick up changes')
} else {
  await build(options)
}
