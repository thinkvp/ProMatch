/*
 * Build the Windows installer: release/ProMatch-<version>-win-setup.exe.
 *
 *   npm run package:win
 *
 * 1. Builds the panel and stages only the files it needs at runtime (no source
 *    map: it carries the TypeScript source).
 * 2. Takes the effect from native/out/ProMatch.aex (build it first, native/PLAN.md).
 * 3. Signs the panel with ZXPSignCmd when it is available ($ZXPSIGNCMD, PATH,
 *    or tools/ZXPSignCmd.exe) so Premiere loads it without PlayerDebugMode.
 *    Unsigned, the installer turns PlayerDebugMode on instead (dev builds only).
 * 4. Compiles installer/windows/ProMatch.iss with Inno Setup's ISCC.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve('.')
const STAGE = join(ROOT, 'release', 'stage')
const PANEL = join(STAGE, 'panel')
const EFFECT = join(STAGE, 'effect')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version

// Runtime files of the CEP panel; everything else in the repo is dev.
const PANEL_FILES = ['CSXS', 'css', 'jsx', 'vendor', 'index.html', 'helper.html', 'dist/panel.js']
const AEX = join(ROOT, 'native', 'out', 'ProMatch.aex')

function fail(msg) {
  console.error(`package-win: ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.error) fail(`${cmd}: ${res.error.message}`)
  if (res.status !== 0) fail(`${cmd} exited with code ${res.status}`)
}

function findTool(envVar, name, candidates) {
  if (process.env[envVar] && existsSync(process.env[envVar])) return process.env[envVar]
  for (const c of candidates) if (c && existsSync(c)) return c
  const where = spawnSync('where', [name], { encoding: 'utf8' })
  return where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : null
}

// Manifest and package.json must agree, or the update check would compare the wrong number.
const manifest = readFileSync('CSXS/manifest.xml', 'utf8')
const bundleVersion = /ExtensionBundleVersion="([^"]+)"/.exec(manifest)?.[1]
if (bundleVersion !== version) fail(`manifest says ${bundleVersion}, package.json says ${version}. Run npm run version:set ${version}.`)

if (!existsSync(AEX)) fail(`${AEX} is missing. Build the effect first (native/PLAN.md).`)
const newestSource = Math.max(...['ProMatch.cpp', 'ProMatch_GPU.cpp', 'lut_engine.cpp'].map((f) => statSync(join(ROOT, 'native', 'src', f)).mtimeMs))
if (statSync(AEX).mtimeMs < newestSource) console.warn('package-win: ProMatch.aex is older than native/src. Rebuild it if that is not intended.')

run(process.execPath, ['esbuild.mjs'])

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(join(PANEL, 'dist'), { recursive: true })
mkdirSync(EFFECT, { recursive: true })
for (const f of PANEL_FILES) {
  if (!existsSync(f)) fail(`missing ${f}`)
  cpSync(f, join(PANEL, f), { recursive: true })
}
cpSync(AEX, join(EFFECT, 'ProMatch.aex'))
// Inside the panel folder, so they are covered by its signature: CEP rejects a
// signed extension with files the signature doesn't list. The installer also
// shows the EULA from the stage root.
cpSync('THIRD-PARTY-NOTICES.md', join(PANEL, 'THIRD-PARTY-NOTICES.md'))
cpSync('installer/EULA.txt', join(PANEL, 'EULA.txt'))
cpSync('installer/EULA.txt', join(STAGE, 'EULA.txt'))

let signed = false
const signCmd = findTool('ZXPSIGNCMD', 'ZXPSignCmd', [join(ROOT, 'tools', 'ZXPSignCmd.exe')])
if (signCmd) {
  // The password is $ZXP_CERT_PASSWORD, else the file beside the certificate
  // (both in the gitignored certs/). A new certificate gets a random one.
  const cert = process.env.ZXP_CERT || join(ROOT, 'certs', 'promatch.p12')
  const passwordFile = `${cert}.password`
  let password = process.env.ZXP_CERT_PASSWORD || (existsSync(passwordFile) ? readFileSync(passwordFile, 'utf8').trim() : '')
  if (!existsSync(cert)) {
    mkdirSync(dirname(cert), { recursive: true })
    if (!password) {
      password = randomBytes(24).toString('base64url')
      writeFileSync(passwordFile, password + '\n')
    }
    console.log(`package-win: no certificate found, creating a self-signed one at ${cert}. Back up certs/ (it is not in git).`)
    run(signCmd, ['-selfSignedCert', 'AU', 'Australia', 'ThinkVP', 'ProMatch', password, cert, '-validityDays', '9125'])
  }
  if (!password) fail(`No password for ${cert}: set ZXP_CERT_PASSWORD or write it to ${passwordFile}.`)
  // Signing writes a .zxp (a zip); its META-INF/signatures.xml is what CEP checks.
  const zxp = join(ROOT, 'release', `ProMatch-${version}.zxp`)
  rmSync(zxp, { force: true })
  // No timestamp by default: ZXPSignCmd 4.1.103 crashes on every timestamp server's
  // reply (tested 2026-10-25). The certificate is valid to 2051, so the signature
  // holds without one. $ZXP_TSA turns it on for a ZXPSignCmd that works.
  const tsa = process.env.ZXP_TSA ? ['-tsa', process.env.ZXP_TSA] : []
  run(signCmd, ['-sign', PANEL, zxp, cert, password, ...tsa])
  run(signCmd, ['-verify', zxp])
  rmSync(PANEL, { recursive: true, force: true })
  mkdirSync(PANEL, { recursive: true })
  // Windows' own tar: Git Bash's GNU tar reads "F:" as a remote host.
  run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zxp, '-C', PANEL])
  signed = true
} else {
  console.warn('package-win: ZXPSignCmd not found. Building an UNSIGNED installer, which turns on PlayerDebugMode. Do not ship it.')
}

const iscc = findTool('ISCC', 'ISCC', [
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
])
if (!iscc) fail('Inno Setup 6 not found (winget install JRSoftware.InnoSetup), or set $ISCC.')

run(iscc, [
  `/DAppVersion=${version}`,
  `/DStageDir=${STAGE}`,
  `/DOutputDir=${join(ROOT, 'release')}`,
  `/DSigned=${signed ? 1 : 0}`,
  '/Qp',
  join(ROOT, 'installer', 'windows', 'ProMatch.iss'),
])
console.log(`\nrelease/ProMatch-${version}-win-setup.exe (${signed ? 'signed panel' : 'UNSIGNED panel'})`)
