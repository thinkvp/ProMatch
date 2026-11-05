/*
 * Install for development: link this folder into the per-user CEP extensions
 * folder (same as Interviewed/ToTheChoppa). No admin needed.
 *   Windows: a junction in %APPDATA%\Adobe\CEP\extensions\ProMatch
 *   macOS:   a symlink in ~/Library/Application Support/Adobe/CEP/extensions/ProMatch,
 *            and PlayerDebugMode switched on for CSXS 9-14 (so the unsigned
 *            dev folder loads).
 * On Windows PlayerDebugMode=1 is set by hand once (already done on the dev PC).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const target = resolve('.')
const mac = process.platform === 'darwin'
const ext = mac
  ? join(homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', 'ProMatch')
  : join(process.env.APPDATA, 'Adobe', 'CEP', 'extensions', 'ProMatch')

if (existsSync(ext)) {
  const kind = lstatSync(ext).isSymbolicLink() ? 'link' : 'folder'
  console.log(`${ext} already exists (${kind}) — leaving it alone.`)
} else {
  mkdirSync(dirname(ext), { recursive: true })
  symlinkSync(target, ext, mac ? 'dir' : 'junction')
  console.log(`Linked ${ext} -> ${target}`)
}

if (mac) {
  for (let v = 9; v <= 14; v++) {
    execFileSync('defaults', ['write', `com.adobe.CSXS.${v}`, 'PlayerDebugMode', '1'])
  }
  console.log('PlayerDebugMode=1 for CSXS 9-14.')
}
console.log('Restart Premiere Pro, then Window > Extensions > ProMatch.')
