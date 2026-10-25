/*
 * Set the version everywhere it is written down: package.json (which the build
 * bakes into the panel for the update check) and the CEP manifest.
 *
 *   node scripts/set-version.mjs 0.2.0
 */
import { readFileSync, writeFileSync } from 'node:fs'

const v = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) {
  console.error('Usage: node scripts/set-version.mjs <major.minor.patch>')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
pkg.version = v
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

const manifestPath = 'CSXS/manifest.xml'
const manifest = readFileSync(manifestPath, 'utf8')
  .replace(/ExtensionBundleVersion="[^"]*"/, `ExtensionBundleVersion="${v}"`)
  .replace(/(<Extension Id="[^"]*" Version=")[^"]*"/g, `$1${v}"`)
writeFileSync(manifestPath, manifest)

console.log(`Version set to ${v}. Rebuild (npm run build) before packaging.`)
