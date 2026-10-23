/*
 * Install for development: junction this folder into the per-user CEP
 * extensions folder (same as Interviewed/ToTheChoppa). No admin needed.
 * Requires PlayerDebugMode=1 for the CSXS version Premiere uses (already set
 * on this machine for CSXS 9-14).
 */
import { existsSync, lstatSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const target = resolve('.')
const ext = join(process.env.APPDATA, 'Adobe', 'CEP', 'extensions', 'ProMatch')

if (existsSync(ext)) {
  const kind = lstatSync(ext).isSymbolicLink() ? 'link' : 'folder'
  console.log(`${ext} already exists (${kind}) — leaving it alone.`)
} else {
  symlinkSync(target, ext, 'junction')
  console.log(`Linked ${ext} -> ${target}`)
}
console.log('Restart Premiere Pro, then Window > Extensions > ProMatch.')
