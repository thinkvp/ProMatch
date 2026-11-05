/*
 * Build the macOS installer: release/ProMatch-<version>-mac.pkg.
 *
 *   npm run package:mac
 *
 * 1. Builds the panel and stages only the files it needs at runtime (as
 *    package-win.mjs does).
 * 2. Takes the effect from native/out/ProMatch.plugin (build it first,
 *    docs/MAC.md) and checks it is universal and validly (ad-hoc) signed.
 * 3. Signs the panel with ZXPSignCmd ($ZXPSIGNCMD, tools/ZXPSignCmd, or PATH)
 *    and the same certificate as the Windows build (certs/promatch.p12), so
 *    Premiere loads it without PlayerDebugMode. Unsigned, the package is named
 *    -UNSIGNED and turns PlayerDebugMode on instead (dev builds only).
 *    PROMATCH_REQUIRE_SIGNED=1 (set by CI) makes that an error instead.
 * 4. pkgbuild + productbuild. No Apple Developer ID, like Syncitol and
 *    Unphased: the package is not notarized, so macOS asks once before opening
 *    it (docs/INSTALL.md). Files the Installer puts in place carry no
 *    quarantine flag, so Premiere then loads the effect without a prompt.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const RELEASE = join(ROOT, 'release')
const STAGE = join(RELEASE, 'stage-mac')
const PAYLOAD = join(STAGE, 'root')
const SCRIPTS = join(STAGE, 'scripts')
const RESOURCES = join(STAGE, 'resources')
const CEP_DIR = 'Library/Application Support/Adobe/CEP/extensions/ProMatch'
const MEDIACORE_DIR = 'Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore'
const PANEL = join(PAYLOAD, CEP_DIR)
const version = JSON.parse(readFileSync('package.json', 'utf8')).version

const PANEL_FILES = ['CSXS', 'css', 'jsx', 'vendor', 'index.html', 'helper.html', 'dist/panel.js']
const PLUGIN = join(ROOT, 'native', 'out', 'ProMatch.plugin')
const PLUGIN_BIN = join(PLUGIN, 'Contents', 'MacOS', 'ProMatch')

function fail(msg) {
  console.error(`package-mac: ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.error) fail(`${cmd}: ${res.error.message}`)
  if (res.status !== 0) fail(`${cmd} exited with code ${res.status}`)
}

function output(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : null
}

function findTool(envVar, name, candidates) {
  if (process.env[envVar] && existsSync(process.env[envVar])) return process.env[envVar]
  for (const c of candidates) if (c && existsSync(c)) return c
  return output('/usr/bin/which', [name])
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

if (process.platform !== 'darwin') fail('run this on a Mac (pkgbuild and productbuild are macOS tools).')

// Manifest, package.json and the effect's bundle version must agree.
const manifest = readFileSync('CSXS/manifest.xml', 'utf8')
const bundleVersion = /ExtensionBundleVersion="([^"]+)"/.exec(manifest)?.[1]
if (bundleVersion !== version) fail(`manifest says ${bundleVersion}, package.json says ${version}. Run npm run version:set ${version}.`)

// ------------------------------------------------------------- the effect
if (!existsSync(PLUGIN_BIN)) fail(`${PLUGIN} is missing. Build the effect first (docs/MAC.md).`)
const pluginVersion = output('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(PLUGIN, 'Contents', 'Info.plist')])
if (pluginVersion !== version) fail(`ProMatch.plugin is version ${pluginVersion}, package.json ${version}. Rebuild the effect (cmake --build native/build).`)
const archs = (output('/usr/bin/lipo', ['-archs', PLUGIN_BIN]) ?? '').split(/\s+/)
for (const want of ['arm64', 'x86_64']) if (!archs.includes(want)) fail(`ProMatch.plugin has no ${want} slice (has: ${archs.join(' ')}).`)
run('/usr/bin/codesign', ['--verify', '--strict', PLUGIN])
const sources = ['ProMatch.cpp', 'ProMatch_GPU.cpp', 'lut_engine.cpp', 'metal_lut.mm', 'mac_ui.mm', 'kernels/ProMatchLut.metal']
const newestSource = Math.max(...sources.map((f) => statSync(join(ROOT, 'native', 'src', f)).mtimeMs))
if (statSync(PLUGIN_BIN).mtimeMs < newestSource) console.warn('package-mac: ProMatch.plugin is older than native/src. Rebuild it if that is not intended.')

// -------------------------------------------------------------- the panel
run(process.execPath, ['esbuild.mjs'])
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(join(PANEL, 'dist'), { recursive: true })
mkdirSync(join(PAYLOAD, MEDIACORE_DIR), { recursive: true })
mkdirSync(SCRIPTS, { recursive: true })
mkdirSync(RESOURCES, { recursive: true })
for (const f of PANEL_FILES) {
  if (!existsSync(f)) fail(`missing ${f}`)
  cpSync(f, join(PANEL, f), { recursive: true })
}
// Inside the panel folder, so the signature covers them (see package-win.mjs).
cpSync('THIRD-PARTY-NOTICES.md', join(PANEL, 'THIRD-PARTY-NOTICES.md'))
cpSync('LICENSE', join(PANEL, 'LICENSE.txt'))
// ditto keeps the bundle exactly as signed (no extended attributes added).
run('/usr/bin/ditto', ['--norsrc', '--noextattr', PLUGIN, join(PAYLOAD, MEDIACORE_DIR, 'ProMatch.plugin')])

let signed = false
const signCmd = findTool('ZXPSIGNCMD', 'ZXPSignCmd', [join(ROOT, 'tools', 'ZXPSignCmd')])
const cert = process.env.ZXP_CERT || join(ROOT, 'certs', 'promatch.p12')
if (signCmd && existsSync(cert)) {
  const passwordFile = `${cert}.password`
  const password = process.env.ZXP_CERT_PASSWORD || (existsSync(passwordFile) ? readFileSync(passwordFile, 'utf8').trim() : '')
  if (!password) fail(`No password for ${cert}: set ZXP_CERT_PASSWORD or write it to ${passwordFile}.`)
  const zxp = join(RELEASE, `ProMatch-${version}-mac.zxp`)
  rmSync(zxp, { force: true })
  const tsa = process.env.ZXP_TSA ? ['-tsa', process.env.ZXP_TSA] : []
  run(signCmd, ['-sign', PANEL, zxp, cert, password, ...tsa])
  run(signCmd, ['-verify', zxp])
  rmSync(PANEL, { recursive: true, force: true })
  mkdirSync(PANEL, { recursive: true })
  run('/usr/bin/ditto', ['-x', '-k', zxp, PANEL])
  signed = true
} else if (signCmd) {
  // Not created here: releases should keep the Windows build's certificate
  // (docs/RELEASING.md). Copy certs/ over from the build PC.
  console.warn(`package-mac: ${cert} not found (copy certs/ from the Windows build machine). Building UNSIGNED.`)
} else {
  console.warn('package-mac: ZXPSignCmd not found (tools/ZXPSignCmd, docs/RELEASING.md). Building UNSIGNED.')
}
// CI (.github/workflows/mac-pkg.yml) sets this: a release must never fall back to unsigned.
if (!signed && process.env.PROMATCH_REQUIRE_SIGNED) fail('PROMATCH_REQUIRE_SIGNED is set, but the panel could not be signed (see above).')
if (!signed) console.warn('package-mac: the UNSIGNED package turns on PlayerDebugMode. Do not ship it.')

// -------------------------------------------------------- install scripts
// preinstall: empty the panel folder (CEP refuses a signed panel with files
// its signature doesn't list) and remove the old effect. rm on the paths
// themselves, so a developer's symlink is removed, not followed.
writeFileSync(
  join(SCRIPTS, 'preinstall'),
  `#!/bin/sh
# ProMatch ${version}: clear the previous install.
rm -rf "/${CEP_DIR}"
rm -rf "/${MEDIACORE_DIR}/ProMatch.plugin"
exit 0
`,
)
// postinstall: unsigned builds only, PlayerDebugMode for the signed-in user.
writeFileSync(
  join(SCRIPTS, 'postinstall'),
  signed
    ? '#!/bin/sh\nexit 0\n'
    : `#!/bin/sh
# UNSIGNED development build: let Premiere load the unsigned panel.
user=$(stat -f%Su /dev/console)
if [ -n "$user" ] && [ "$user" != "root" ]; then
  for v in 9 10 11 12 13 14; do sudo -u "$user" defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
fi
exit 0
`,
)
chmodSync(join(SCRIPTS, 'preinstall'), 0o755)
chmodSync(join(SCRIPTS, 'postinstall'), 0o755)

// ------------------------------------------------------------- packages
// The plug-in must land where the payload says, not be "relocated" by the
// Installer to some other copy of the bundle it finds (a dev build, say).
const components = join(STAGE, 'components.plist')
run('/usr/bin/pkgbuild', ['--analyze', '--root', PAYLOAD, components])
const plist = readFileSync(components, 'utf8')
writeFileSync(
  components,
  plist
    .replace(/<key>BundleIsRelocatable<\/key>\s*<true\/>/g, '<key>BundleIsRelocatable</key>\n\t\t<false/>')
    .replace(/<key>BundleIsVersionChecked<\/key>\s*<true\/>/g, '<key>BundleIsVersionChecked</key>\n\t\t<false/>'),
)
const component = join(STAGE, 'ProMatch-component.pkg')
run('/usr/bin/pkgbuild', [
  '--root', PAYLOAD,
  '--component-plist', components,
  '--scripts', SCRIPTS,
  '--identifier', 'com.promatch.pkg',
  '--version', version,
  '--install-location', '/',
  '--ownership', 'recommended',
  component,
])

cpSync('LICENSE', join(RESOURCES, 'LICENSE.txt'))
writeFileSync(
  join(RESOURCES, 'welcome.html'),
  `<!doctype html><html><body style="font-family:-apple-system,sans-serif;font-size:13px">
<p><b>ProMatch ${xml(version)}</b>: matches one camera angle's colour to another in Premiere Pro.</p>
<p>Close Premiere Pro and Media Encoder before installing. This installs:</p>
<ul><li>the ProMatch panel (Window ▸ Extensions ▸ ProMatch)</li>
<li>the ProMatch effect (Effects ▸ Video Effects ▸ ProMatch)</li></ul>
<p>Needs Premiere Pro 2021 (15.0) or later and macOS 11 or later.</p>
${signed ? '' : '<p><b>Development build:</b> the panel is unsigned and this turns on PlayerDebugMode.</p>'}
</body></html>
`,
)
const distribution = join(STAGE, 'distribution.xml')
writeFileSync(
  distribution,
  `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>ProMatch ${xml(version)}</title>
    <welcome file="welcome.html" mime-type="text/html"/>
    <license file="LICENSE.txt" mime-type="text/plain"/>
    <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
    <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
    <volume-check>
        <allowed-os-versions><os-version min="11.0"/></allowed-os-versions>
    </volume-check>
    <installation-check script="pmAdobeClosed()"/>
    <script><![CDATA[
    // Like the Windows installer: Premiere and Media Encoder hold the effect
    // open and only load new panels and effects at start-up. Any version
    // (com.adobe.PremierePro.26, com.adobe.ame.application.26, ...).
    function pmAdobeClosed() {
        var apps = [];
        try { apps = system.applications.all(); } catch (e) { return true; }
        for (var i = 0; i < apps.length; i++) {
            var id = String(apps[i].bundleIdentifier || '');
            if (id.indexOf('com.adobe.PremierePro') == 0 || id.indexOf('com.adobe.ame') == 0) {
                my.result.title = 'Close Premiere Pro and Media Encoder';
                my.result.message = 'Quit Premiere Pro and Adobe Media Encoder, then open the ProMatch installer again.';
                my.result.type = 'Fatal';
                return false;
            }
        }
        return true;
    }
    ]]></script>
    <choices-outline><line choice="default"><line choice="com.promatch.pkg"/></line></choices-outline>
    <choice id="default"/>
    <choice id="com.promatch.pkg" visible="false"><pkg-ref id="com.promatch.pkg"/></choice>
    <pkg-ref id="com.promatch.pkg" version="${xml(version)}" onConclusion="none">ProMatch-component.pkg</pkg-ref>
</installer-gui-script>
`,
)
const out = join(RELEASE, `ProMatch-${version}-mac${signed ? '' : '-UNSIGNED'}.pkg`)
rmSync(out, { force: true })
run('/usr/bin/productbuild', ['--distribution', distribution, '--resources', RESOURCES, '--package-path', STAGE, out])
console.log(`\n${out.slice(ROOT.length + 1)} (${signed ? 'signed panel' : 'UNSIGNED panel'})`)
