/**
 * File-system access through CEP's Node (--enable-nodejs --mixed-context).
 * In a plain browser `require` does not exist and `hasNode` is false; the
 * panel then falls back to file pickers and downloads.
 */
type Fs = typeof import('fs')
type Path = typeof import('path')
type Os = typeof import('os')
type ChildProcess = typeof import('child_process')
type Zlib = typeof import('zlib')

// Read it off globalThis: a bare `require` is rewritten by esbuild into a shim
// that always exists, which would make every browser look like CEP.
const globalRequire = (globalThis as { require?: unknown }).require
const req = typeof globalRequire === 'function' ? (globalRequire as (id: string) => unknown) : null

export const hasNode = req !== null
const fs = req ? (req('fs') as Fs) : null
const path = req ? (req('path') as Path) : null
const os = req ? (req('os') as Os) : null
const cp = req ? (req('child_process') as ChildProcess) : null
const zlib = req ? (req('zlib') as Zlib) : null

function need<T>(m: T | null): T {
  if (!m) throw new Error('File access needs Premiere (CEP Node is unavailable).')
  return m
}

export function join(...parts: string[]): string {
  return need(path).join(...parts)
}

/** Running on macOS (CEP's Node, or a browser on a Mac). */
export const isMac =
  typeof process !== 'undefined' && process.platform ? process.platform === 'darwin' : /Mac/.test(navigator.platform)

/** The file manager's name, for "Show in …" buttons. */
export const fileManager = isMac ? 'Finder' : 'Explorer'

/**
 * Captures and the saved session: %APPDATA%\ProMatch on Windows,
 * ~/Library/Application Support/ProMatch on macOS. The native effect uses the
 * same folder (lut_engine.cpp dataPath), and so does helper.html.
 */
export function dataDir(): string {
  const home = need(os).homedir()
  const base = isMac
    ? join(home, 'Library', 'Application Support')
    : process.env.APPDATA || join(home, 'AppData', 'Roaming')
  return ensureDir(join(base, 'ProMatch'))
}

export function capturesDir(): string {
  return ensureDir(join(dataDir(), 'captures'))
}

/**
 * Where LUTs are saved: a "ProMatch LUTs" folder beside the saved .prproj, so
 * they travel and get backed up with the project. Documents\ProMatch LUTs
 * when the project has never been saved (its path is not on disk yet).
 * Only the path: callers that write create it, so opening the panel leaves
 * no empty folder beside the project.
 */
export function lutDir(projectPath: string | null = null): { dir: string; withProject: boolean } {
  if (projectPath && /\.prproj$/i.test(projectPath) && exists(projectPath)) {
    return { dir: join(need(path).dirname(projectPath), 'ProMatch LUTs'), withProject: true }
  }
  return { dir: join(need(os).homedir(), 'Documents', 'ProMatch LUTs'), withProject: false }
}

export function ensureDir(dir: string): string {
  need(fs).mkdirSync(dir, { recursive: true })
  return dir
}

export function exists(p: string): boolean {
  return !!fs && fs.existsSync(p)
}

export function readText(p: string): string {
  return need(fs).readFileSync(p, 'utf8')
}

export function writeText(p: string, text: string): void {
  need(fs).writeFileSync(p, text, 'utf8')
}

/** Write via a temp file and rename, so a reader (the native effect) never sees half a file. */
export function writeTextAtomic(p: string, text: string): void {
  const tmp = `${p}.${process.pid}.tmp`
  need(fs).writeFileSync(tmp, text, 'utf8')
  need(fs).renameSync(tmp, p)
}

/** Folder entries (names), or [] if it doesn't exist. */
export function listDir(dir: string): string[] {
  try {
    return need(fs).readdirSync(dir)
  } catch {
    return []
  }
}

export function rename(from: string, to: string): void {
  need(fs).renameSync(from, to)
}

/** Modification time in ms, or 0 if missing. */
export function mtime(p: string): number {
  try {
    return need(fs).statSync(p).mtimeMs
  } catch {
    return 0
  }
}

export function isAbsolute(p: string): boolean {
  return need(path).isAbsolute(p)
}

export function basename(p: string): string {
  return need(path).basename(p)
}

export function copyFile(from: string, to: string): void {
  need(fs).copyFileSync(from, to)
}

export function writeBytes(p: string, bytes: ArrayBuffer): void {
  need(fs).writeFileSync(p, Buffer.from(bytes))
}

export function readDataUrl(p: string): string {
  const ext = need(path).extname(p).slice(1).toLowerCase()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'tif' || ext === 'tiff' ? 'image/tiff' : 'image/png'
  return `data:${mime};base64,${need(fs).readFileSync(p).toString('base64')}`
}

/**
 * Wait for the first of `candidates` to exist AND stop growing — QE writes the
 * PNG asynchronously and a half-written file decodes as a broken image.
 */
export async function waitForFile(candidates: string[], timeoutMs = 15000): Promise<string> {
  const f = need(fs)
  const start = Date.now()
  let lastSize = -1
  let lastPath = ''
  while (Date.now() - start < timeoutMs) {
    for (const p of candidates) {
      if (!f.existsSync(p)) continue
      const size = f.statSync(p).size
      if (size > 0 && p === lastPath && size === lastSize) return p
      lastPath = p
      lastSize = size
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('Premiere did not write the frame (timed out). Is the Program Monitor showing a frame?')
}

/** Most recently modified .cube in a folder, or null. */
export function newestCube(dir: string): string | null {
  const f = need(fs)
  let best: string | null = null
  let bestT = -1
  for (const name of listDir(dir)) {
    if (!name.toLowerCase().endsWith('.cube')) continue
    const p = join(dir, name)
    const t = f.statSync(p).mtimeMs
    if (t > bestT) {
      best = p
      bestT = t
    }
  }
  return best
}

export function reveal(p: string): void {
  if (isMac) need(cp).execFile('open', ['-R', p])
  else need(cp).exec(`explorer /select,"${p}"`)
}

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'ProMatch'
}

/** A fresh match ID (1…9,999,999); it travels in the effect's LUT text. */
export function newMatchId(): number {
  return 1 + Math.floor(Math.random() * 9999998)
}

export function remove(p: string): void {
  try {
    need(fs).unlinkSync(p)
  } catch {
    // Already gone, or locked: a stray capture is harmless.
  }
}

let gammaCache: { path: string; mtime: number; gamma: number } | null = null

/** Premiere's Viewer Gamma when the project has never changed it. */
export const DEFAULT_VIEWER_GAMMA = 2.4

/**
 * The project's Viewer Gamma (1.96, 2.2 or 2.4) as last saved: ExtendScript
 * doesn't expose it, but the .prproj (gzipped XML) keeps it in
 * ColorManagementSettings as "sdrGamma":220. Premiere only writes it once it
 * differs from the default (a project showing 2.4 in Project Settings › Color
 * has no sdrGamma), so a missing key means 2.4. Throws if the file can't be read.
 */
export async function projectViewerGamma(projectPath: string): Promise<number> {
  const t = mtime(projectPath)
  if (gammaCache && gammaCache.path === projectPath && gammaCache.mtime === t) return gammaCache.gamma
  const f = need(fs)
  const z = need(zlib)
  let buf: Buffer = await f.promises.readFile(projectPath)
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await new Promise<Buffer>((res, rej) => z.gunzip(buf, (e, out) => (e ? rej(e) : res(out))))
  const m = /"sdrGamma"\s*:\s*(\d+)/.exec(buf.toString('utf8'))
  const gamma = m ? Number(m[1]) / 100 : DEFAULT_VIEWER_GAMMA
  gammaCache = { path: projectPath, mtime: t, gamma }
  return gamma
}
