/*
 * ProMatch UXP spike: can a UXP panel do what the CEP panel does?
 * Each button runs one test and merges its findings into out/results.json
 * (frames land in out/ too), so they can be checked outside Premiere.
 * Plain JS, no build step except core.js (src/core bundled by build.mjs).
 */
const ppro = require('premierepro')
const uxp = require('uxp')
const lfs = uxp.storage.localFileSystem

const logEl = document.getElementById('log')
function log(msg) {
  logEl.textContent = `${msg}\n${logEl.textContent}`.slice(0, 6000)
}
const errText = (e) => (e && (e.stack || e.message)) || String(e)

// ------------------------------------------------------------------ files

let outDirCache = null
/** out/ beside this plugin, as a native path with forward slashes. */
async function outDir() {
  if (outDirCache) return outDirCache
  const plugin = await lfs.getPluginFolder()
  outDirCache = `${plugin.nativePath.replace(/\\/g, '/').replace(/\/$/, '')}/out`
  return outDirCache
}

async function folderEntry(path) {
  try {
    return await lfs.getEntryWithUrl(`file:${path}`)
  } catch {
    // Create it (and only it: its parent is the plugin folder).
    const parent = await lfs.getEntryWithUrl(`file:${path.slice(0, path.lastIndexOf('/'))}`)
    return parent.createFolder(path.slice(path.lastIndexOf('/') + 1))
  }
}

async function writeText(name, text) {
  const dir = await folderEntry(await outDir())
  const f = await dir.createFile(name, { overwrite: true })
  await f.write(text)
}

async function readText(name) {
  const f = await lfs.getEntryWithUrl(`file:${await outDir()}/${name}`)
  return f.read()
}

async function readBytes(path) {
  const f = await lfs.getEntryWithUrl(`file:${path}`)
  return new Uint8Array(await f.read({ format: uxp.storage.formats.binary }))
}

/** Merge one test's findings into results.json. */
async function record(test, findings) {
  let all = {}
  try {
    all = JSON.parse(await readText('results.json'))
  } catch {
    // first test
  }
  all[test] = { at: new Date().toISOString(), ...findings }
  let platform = 'unknown'
  try {
    platform = require('os').platform()
  } catch {
    // no os module
  }
  all.env = { uxp: uxp.versions, host: uxp.host, platform }
  await writeText('results.json', JSON.stringify(all, null, 1))
  log(`${test}: ${JSON.stringify(findings).slice(0, 400)}`)
}

async function run(test, fn) {
  const findings = {}
  try {
    await fn(findings)
  } catch (e) {
    findings.error = errText(e)
  }
  try {
    await record(test, findings)
  } catch (e) {
    log(`${test}: could not write results (${errText(e)}). Findings: ${JSON.stringify(findings)}`)
  }
}

// ---------------------------------------------------------------- Premiere

async function context() {
  const project = await ppro.Project.getActiveProject()
  if (!project) throw new Error('No active project')
  const seq = await project.getActiveSequence()
  if (!seq) throw new Error('No active sequence')
  return { project, seq }
}

/** Context for the tests that change a clip, recording which project they ran in. */
async function scratchContext(findings) {
  const ctx = await context()
  findings.project = { name: ctx.project.name, path: ctx.project.path }
  return ctx
}

async function exists(path) {
  try {
    await lfs.getEntryWithUrl(`file:${path}`)
    return true
  } catch {
    return false
  }
}

/** Wait up to `ms` for a file to appear (the export may write after it returns). */
async function waitFor(path, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await exists(path)) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

/**
 * The docs' filename/filepath split is ambiguous, so try each form until a
 * file actually appears; later calls reuse the form that worked.
 */
let exportForm = null
const EXPORT_FORMS = {
  nameAndDir: (dir, name) => [name, `${dir}/`],
  pathAndDir: (dir, name) => [`${dir}/${name}`, `${dir}/`],
  nameAndBackslashDir: (dir, name) => [name, `${dir.replace(/\//g, '\\')}\\`],
  backslashPathAndDir: (dir, name) => [`${dir}/${name}`.replace(/\//g, '\\'), `${dir.replace(/\//g, '\\')}\\`],
  nameNoExtAndDir: (dir, name) => [name.replace(/\.\w+$/, ''), `${dir}/`],
}

async function exportFrame(seq, base, findings) {
  const dir = await outDir()
  const time = await seq.getPlayerPosition()
  const size = await seq.getFrameSize()
  findings.playheadSeconds = time.seconds
  findings.frameSize = [size.width, size.height]
  for (const ext of ['png', 'bmp']) {
    const name = `${base}.${ext}`
    const tries = []
    for (const [form, args] of Object.entries(EXPORT_FORMS)) {
      if (exportForm && form !== exportForm) continue
      const [filename, filepath] = args(dir, name)
      const t0 = Date.now()
      let returned
      try {
        returned = await ppro.Exporter.exportSequenceFrame(seq, time, filename, filepath, size.width, size.height)
      } catch (e) {
        returned = `threw: ${errText(e)}`
      }
      const appearedAfterMs = await waitFor(`${dir}/${name}`, 6000)
      tries.push({ form, filename, filepath, returned, callMs: Date.now() - t0, appearedAfterMs })
      if (appearedAfterMs !== null) {
        exportForm = form
        break
      }
    }
    findings[`${ext}Export`] = tries
  }
}

async function selectedVideoItem(seq) {
  const sel = await seq.getSelection()
  const items = await sel.getTrackItems()
  for (const it of items) {
    try {
      const type = await it.getMediaType()
      // Guid vs enum: keep the first item whose chain has video components.
      const chain = await it.getComponentChain()
      if (chain && typeof chain.createAppendComponentAction === 'function' && chain.getComponentCount() >= 1) {
        return { item: it, chain, mediaType: String(type) }
      }
    } catch {
      // not a clip with a video chain
    }
  }
  throw new Error('Select one video clip in the Timeline')
}

async function describeChain(chain) {
  const out = []
  for (let i = 0; i < chain.getComponentCount(); i++) {
    const c = chain.getComponentAtIndex(i)
    const params = []
    for (let p = 0; p < c.getParamCount(); p++) params.push(c.getParam(p).displayName)
    out.push({ index: i, matchName: await c.getMatchName(), displayName: await c.getDisplayName(), params })
  }
  return out
}

function transact(project, label, build) {
  let ok
  project.lockedAccess(() => {
    ok = project.executeTransaction((ca) => {
      for (const a of build()) ca.addAction(a)
    }, label)
  })
  return ok
}

async function findProMatch(chain) {
  for (let i = chain.getComponentCount() - 1; i >= 0; i--) {
    const c = chain.getComponentAtIndex(i)
    if (/ProMatch|PRMT/.test(await c.getMatchName())) return c
  }
  return null
}

function paramByName(comp, name) {
  for (let p = 0; p < comp.getParamCount(); p++) {
    const param = comp.getParam(p)
    if (param.displayName === name) return { param, index: p }
  }
  return null
}

// ------------------------------------------------------------------- tests

document.getElementById('t1').addEventListener('click', () =>
  run('t1_exportFrame', async (f) => {
    const { project, seq } = await context()
    f.project = { name: project.name, path: project.path }
    await exportFrame(seq, 'uxp-frame', f)
  }),
)

/** Minimal BMP reader: Premiere's BMP export gives pixels without any inflate. */
function readBmp(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint16(0, true) !== 0x4d42) throw new Error('not a BMP')
  const offset = dv.getUint32(10, true)
  const width = dv.getInt32(18, true)
  const rawH = dv.getInt32(22, true)
  const bpp = dv.getUint16(28, true)
  const height = Math.abs(rawH)
  const stride = Math.ceil((width * bpp) / 32) * 4
  const rgba = new Uint8ClampedArray(width * height * 4)
  const bytesPP = bpp / 8
  for (let y = 0; y < height; y++) {
    const row = offset + (rawH > 0 ? height - 1 - y : y) * stride
    for (let x = 0; x < width; x++) {
      const s = row + x * bytesPP
      const o = (y * width + x) * 4
      rgba[o] = bytes[s + 2]
      rgba[o + 1] = bytes[s + 1]
      rgba[o + 2] = bytes[s]
      rgba[o + 3] = 255
    }
  }
  return { width, height, bpp, data: rgba }
}

// A tiny wasm module exporting add(a, b).
const WASM_ADD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11])

document.getElementById('t2').addEventListener('click', () =>
  run('t2_pixels', async (f) => {
    // Saved after each section, so a hang still shows how far it got.
    const cp = (step) => record('t2_pixels', { ...f, partialAfter: step })
    await cp('start')
    const g = globalThis
    f.globals = {
      btoa: typeof g.btoa,
      atob: typeof g.atob,
      TextEncoder: typeof g.TextEncoder,
      DecompressionStream: typeof g.DecompressionStream,
      createImageBitmap: typeof g.createImageBitmap,
      ImageData: typeof g.ImageData,
      OffscreenCanvas: typeof g.OffscreenCanvas,
      WebAssembly: typeof g.WebAssembly,
      Worker: typeof g.Worker,
      requestAnimationFrame: typeof g.requestAnimationFrame,
    }

    await cp('globals')
    // Canvas 2D: does pixel access exist at all?
    try {
      const c = document.createElement('canvas')
      c.width = 4
      c.height = 4
      const ctx = c.getContext('2d')
      f.canvas = { context: !!ctx }
      if (ctx) {
        for (const m of ['getImageData', 'putImageData', 'createImageData', 'drawImage', 'fillRect']) f.canvas[m] = typeof ctx[m]
        try {
          ctx.fillStyle = 'rgb(200,100,50)'
          ctx.fillRect(0, 0, 4, 4)
          const d = ctx.getImageData(0, 0, 1, 1).data
          f.canvas.readBack = [d[0], d[1], d[2]]
        } catch (e) {
          f.canvas.readBackError = errText(e)
        }
      }
    } catch (e) {
      f.canvasError = errText(e)
    }

    await cp('canvas')
    // Pixels from Premiere's own export, without canvas or inflate: BMP.
    try {
      const bytes = await readBytes(`${await outDir()}/uxp-frame.bmp`)
      const t0 = Date.now()
      const img = readBmp(bytes)
      let sum = 0
      for (let i = 0; i < img.data.length; i += 4) sum += img.data[i] + img.data[i + 1] + img.data[i + 2]
      f.bmp = { width: img.width, height: img.height, bpp: img.bpp, decodeMs: Date.now() - t0, meanLevel: sum / (img.data.length * 0.75) }
    } catch (e) {
      f.bmpError = `${errText(e)} (run test 1 first)`
    }

    // PNG via DecompressionStream, if it exists.
    if (typeof g.DecompressionStream === 'function') {
      try {
        const ds = new DecompressionStream('deflate')
        f.decompressionStream = 'constructed'
        void ds
      } catch (e) {
        f.decompressionStream = errText(e)
      }
    }

    await cp('bmp')
    // ProMatch's engine (src/core), bundled into core.js.
    try {
      const C = g.PMCore
      const t0 = Date.now()
      const pairs = [
        [[0.6, 0.5, 0.4], [0.5, 0.45, 0.42]],
        [[0.3, 0.35, 0.5], [0.25, 0.32, 0.5]],
        [[0.75, 0.2, 0.15], [0.62, 0.22, 0.2]],
        [[0.4, 0.55, 0.3], [0.33, 0.5, 0.3]],
      ].map(([s, t]) => ({ source: { rgb: s, spread: 0, clipped: false }, target: { rgb: t, spread: 0, clipped: false } }))
      const model = C.fitMatch(pairs, C.DEFAULT_OPTIONS)
      const lut = C.bakeLut(33, (c) => C.applyModel(model, c))
      f.core = { fitAndBake33Ms: Date.now() - t0, exposureStops: model.exposureStops }
      try {
        f.core.embeddedTextLength = C.toEmbeddedText(lut).length
      } catch (e) {
        f.core.embeddedTextError = errText(e)
      }
    } catch (e) {
      f.coreError = errText(e)
    }

    await cp('core')
    // WebAssembly: a tiny module.
    try {
      const { instance } = await WebAssembly.instantiate(WASM_ADD)
      f.wasmAdd = instance.exports.add(2, 3)
    } catch (e) {
      f.wasmError = errText(e)
    }
  }),
)

document.getElementById('t2b').addEventListener('click', () =>
  run('t2b_opencv', async (f) => {
    // Crashed Premiere once (one of these two): scratch projects only.
    await scratchContext(f)
    await record('t2b_opencv', { started: true, project: f.project })
    try {
      const t0 = Date.now()
      let cv = require('./vendor/opencv.js')
      if (cv && typeof cv.then === 'function') {
        cv = await Promise.race([new Promise((r) => cv.then((m) => r(m))), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30 s')), 30000))])
      }
      f.opencv = { loadMs: Date.now() - t0, hasMat: typeof cv.Mat, hasAKAZE: typeof cv.AKAZE }
    } catch (e) {
      f.opencvError = errText(e)
    }
  }),
)

document.getElementById('t2c').addEventListener('click', () =>
  run('t2c_webview', async (f) => {
    // Crashed Premiere once (one of these two): scratch projects only.
    await scratchContext(f)
    await record('t2c_webview', { started: true, project: f.project })
    // A full browser inside the panel, as an escape hatch for the UI.
    try {
      const wv = document.createElement('webview')
      wv.style.width = '100%'
      wv.style.height = '40px'
      const got = new Promise((resolve) => {
        window.addEventListener('message', (e) => resolve(e.data))
        wv.addEventListener('message', (e) => resolve(e.message ?? e.data))
        setTimeout(() => resolve('no message within 8 s'), 8000)
      })
      wv.setAttribute('uxpAllowInspector', 'true')
      wv.src = 'plugin:/webview.html'
      document.body.appendChild(wv)
      f.webview = { element: wv.tagName, message: await got }
    } catch (e) {
      f.webviewError = errText(e)
    }
  }),
)

document.getElementById('t2d').addEventListener('click', () =>
  run('t2d_webviewSources', async (f) => {
    // Which page sources load, and do load / message events fire?
    const dir = (await lfs.getPluginFolder()).nativePath.replace(/\\/g, '/')
    const sources = {
      plugin: 'plugin:/webview.html',
      file: `file:///${dir}/webview.html`,
      https: 'https://example.com/',
    }
    for (const [name, src] of Object.entries(sources)) {
      const events = []
      const wv = document.createElement('webview')
      wv.style.width = '100%'
      wv.style.height = '60px'
      for (const ev of ['loadstart', 'loadstop', 'loaderror', 'message']) {
        wv.addEventListener(ev, (e) => events.push({ ev, at: Date.now(), message: e.message ?? e.data, url: e.url, code: e.code }))
      }
      const t0 = Date.now()
      wv.src = src
      document.body.appendChild(wv)
      await new Promise((r) => setTimeout(r, 6000))
      f[name] = { src, events: events.map((e) => ({ ...e, at: e.at - t0 })) }
      await record('t2d_webviewSources', { ...f, partialAfter: name })
    }
  }),
)

document.getElementById('t3').addEventListener('click', () =>
  run('t3_addEffect', async (f) => {
    const { project, seq } = await scratchContext(f)
    const { chain } = await selectedVideoItem(seq)
    const names = await ppro.VideoFilterFactory.getMatchNames()
    f.matchNameCandidates = names.filter((n) => /ProMatch|PRMT/i.test(n))
    f.lumetriMatchName = names.filter((n) => /Lumetri/i.test(n))
    if (!f.matchNameCandidates.length) throw new Error('ProMatch effect not in VideoFilterFactory.getMatchNames()')
    f.before = await describeChain(chain)
    const comp = await ppro.VideoFilterFactory.createComponent(f.matchNameCandidates[0])
    f.transaction = transact(project, 'ProMatch spike: add effect', () => [chain.createAppendComponentAction(comp)])
    const { chain: after } = await selectedVideoItem(seq)
    f.after = await describeChain(after)
    await exportFrame(seq, 'uxp-after-add', f)
  }),
)

/** Fresh ProMatch component on the selected clip (script objects go stale across awaits). */
async function freshProMatch(seq) {
  const { chain } = await selectedVideoItem(seq)
  const comp = await findProMatch(chain)
  if (!comp) throw new Error('No ProMatch effect on the selected clip (run test 3)')
  return comp
}

/** Rejects if `p` hasn't settled in `ms` (some UXP calls never do). */
function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms))])
}

/** A keyframe's value, summarised: type, length and head for text. */
function kfValue(kf) {
  const v = kf && kf.value !== undefined ? (kf.value && typeof kf.value === 'object' && 'value' in kf.value ? kf.value.value : kf.value) : undefined
  return typeof v === 'string' ? { type: 'string', length: v.length, head: v.slice(0, 40) } : { type: typeof v, value: v }
}

async function readParams(seq, f, key) {
  const comp = await freshProMatch(seq)
  const out = {}
  for (const name of ['Match ID', 'Amount', 'LUT']) {
    const p = paramByName(comp, name)
    if (!p) continue
    try {
      out[name] = kfValue(await withTimeout(p.param.getStartValue(), 4000, `${name}.getStartValue`))
    } catch (e) {
      out[name] = { error: errText(e) }
    }
  }
  f[key] = out
  return out
}

/** One attempt: build the action(s) synchronously from fresh objects, then run them in one transaction. */
async function attempt(f, label, project, seq, build) {
  const r = {}
  try {
    const comp = await freshProMatch(seq)
    let actions
    try {
      actions = build(comp, r)
    } catch (e) {
      r.buildError = errText(e)
    }
    if (actions && actions.length) r.transaction = transact(project, `ProMatch spike: ${label}`, () => actions)
  } catch (e) {
    r.error = errText(e)
  }
  f[label] = r
}

document.getElementById('t4').addEventListener('click', () =>
  run('t4_setParams', async (f) => {
    const { project, seq } = await scratchContext(f)
    const lutText = (await (await lfs.getEntryWithUrl(`file:${(await lfs.getPluginFolder()).nativePath.replace(/\\/g, '/')}/lut-invert.txt`)).read()).trim()
    f.sentLength = lutText.length
    const cp = (step) => record('t4_setParams', { ...f, partialAfter: step })
    await cp('start')
    await readParams(seq, f, 'before')
    await cp('before')

    // Control: plain numbers through createKeyframe.
    await attempt(f, 'numbers', project, seq, (comp) => {
      const id = paramByName(comp, 'Match ID').param
      const amt = paramByName(comp, 'Amount').param
      return [id.createSetValueAction(id.createKeyframe(4242), true), amt.createSetValueAction(amt.createKeyframe(100), true)]
    })
    await readParams(seq, f, 'afterNumbers')
    await cp('numbers')

    // LUT, route A: createKeyframe(string).
    await attempt(f, 'lutCreateKeyframe', project, seq, (comp) => {
      const lut = paramByName(comp, 'LUT').param
      return [lut.createSetValueAction(lut.createKeyframe(lutText), true)]
    })
    await cp('lutCreateKeyframe')

    // LUT, route B: take the start keyframe, put the text in it, set that.
    const r = {}
    try {
      const lut = paramByName(await freshProMatch(seq), 'LUT').param
      const kf = await withTimeout(lut.getStartValue(), 4000, 'LUT.getStartValue')
      r.startValue = kfValue(kf)
      try {
        if (kf.value && typeof kf.value === 'object' && 'value' in kf.value) kf.value.value = lutText
        else kf.value = { value: lutText }
      } catch (e) {
        r.assignError = errText(e)
      }
      r.afterAssign = kfValue(kf)
      try {
        const action = lut.createSetValueAction(kf, true)
        r.transaction = transact(project, 'ProMatch spike: set LUT (keyframe)', () => [action])
      } catch (e) {
        r.setError = errText(e)
      }
    } catch (e) {
      r.error = errText(e)
    }
    f.lutStartKeyframe = r
    await cp('lutKeyframe')
    const after = await readParams(seq, f, 'afterLut')
    f.lutTookEffect = !!after.LUT && after.LUT.length === lutText.length && after.LUT.head === lutText.slice(0, 40)
    await writeText('expected-lut-head.txt', lutText.slice(0, 200))
    await exportFrame(seq, 'uxp-after-lut', f)
  }),
)

document.getElementById('t5').addEventListener('click', () =>
  run('t5_readBack', async (f) => {
    const { seq } = await scratchContext(f)
    const now = await readParams(seq, f, 'params')
    let expected = ''
    try {
      expected = await readText('expected-lut-head.txt')
    } catch {
      // test 4 not run in this folder
    }
    f.matchesTest4 = !!expected && !!now.LUT && now.LUT.head === expected.slice(0, 40)
    await exportFrame(seq, 'uxp-readback', f)
  }),
)

document.getElementById('undo').addEventListener('click', () =>
  run('cleanup', async (f) => {
    const { project, seq } = await scratchContext(f)
    const { chain } = await selectedVideoItem(seq)
    const comp = await findProMatch(chain)
    if (!comp) throw new Error('No ProMatch effect on the selected clip')
    f.transaction = transact(project, 'ProMatch spike: remove effect', () => [chain.createRemoveComponentAction(comp)])
    f.after = await describeChain((await selectedVideoItem(seq)).chain)
  }),
)

log('Ready. Park the playhead on a clip and run 1, then 2.')
