# Releasing

Releases are GitHub releases on [thinkvp/ProMatch](https://github.com/thinkvp/ProMatch). The
panel's update check (`src/panel/update.ts`) asks GitHub's API for the latest one without
signing in, so **the repo has to stay public**: GitHub answers 404 for a private repo.

## One-time setup

- **Inno Setup 6:** `winget install JRSoftware.InnoSetup`.
- **ZXPSignCmd** (signs the panel so Premiere loads it without PlayerDebugMode): version
  4.1.103 `win64/ZXPSignCmd.exe` from
  [Adobe-CEP/CEP-Resources ▸ ZXPSignCMD](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD),
  saved as `tools/ZXPSignCmd.exe` (gitignored), or on `PATH`. Adobe lists its MD5 as
  `96f1c5fe970733dae5e2b17d8643ae87`, and the file carries Adobe Inc.'s code signature.
- **Certificate:** `certs/promatch.p12`, self-signed, valid to 2051, with its password in
  `certs/promatch.p12.password` (both gitignored; `ZXP_CERT_PASSWORD` overrides the file). The
  first signed build creates them if they're missing. **Back up the `certs/` folder** (a password
  manager takes both): a lost certificate isn't fatal, since each install checks its own
  signature, but releases should keep signing with the same one.
- **No timestamp:** ZXPSignCmd 4.1.103 crashes on the reply of every timestamp server tried
  (DigiCert, Sectigo, SSL.com, GlobalSign, Entrust; 2026-10-25), so signatures aren't
  timestamped. That's fine while the certificate is valid (to 2051). Set `ZXP_TSA` to a server
  URL to turn timestamping on with a ZXPSignCmd that works.
- The panel's files, the third-party notices and the licence are all inside the signature. The
  installer empties the panel folder before copying, because a file the signature doesn't list
  makes CEP refuse the panel.
- **The effect:** see `native/PLAN.md` for the SDKs and toolchain.
- **macOS** (on the Mac): the Command Line Tools (`xcode-select --install`), CMake, Node, and the
  macOS AE and Premiere Pro SDKs in `native/sdk/` ([MAC.md](MAC.md)). ZXPSignCmd 4.1.3
  `macOS/ZXPSignCmd` from the same Adobe repo, saved as `tools/ZXPSignCmd` (gitignored,
  `chmod +x`). It's an unsigned Intel binary: it runs under Rosetta, and macOS asks once to allow
  it (System Settings ▸ Privacy & Security). SHA-256 of the copy in use:
  `bc773fae0b97416fc7a462e7dadcc00270428a9913480c9b78b5606ff1cfb095`. Copy `certs/` over from
  the Windows machine so both platforms sign with the same certificate; `package:mac` won't
  make a new one.
- **No Apple Developer ID**, like Syncitol and Unphased: the effect carries an ad-hoc signature
  and the `.pkg` isn't notarized, so users allow it once ([INSTALL.md](INSTALL.md#macos)).

## Each release

1. Update `CHANGELOG.md`: rename **Unreleased** to the new version.
2. Set the version (package.json and `CSXS/manifest.xml` together):

   ```bash
   npm run version:set 0.2.0
   ```

3. Build and test the effect (`native/PLAN.md`; on the Mac, [MAC.md](MAC.md)), then run the checks:

   ```bash
   npm test
   ```

4. Build the installer:

   ```bash
   npm run package:win
   ```

   This writes `release/ProMatch-0.2.0-win-setup.exe`, and `release/release-notes.md` from the
   version's changelog section. It stops if `native/out/ProMatch.aex` is older than anything in
   `native/src` (rebuild it, or set `PROMATCH_ALLOW_STALE_AEX=1` if that's intended). A build without ZXPSignCmd is
   **unsigned** and switches on PlayerDebugMode on the user's machine; it says so loudly. Don't
   ship one.

   On the Mac, from the same commit: build the effect (`cmake --build native/build`), then

   ```bash
   npm run package:mac
   ```

   This writes `release/ProMatch-0.2.0-mac.pkg`. Without ZXPSignCmd or `certs/` it writes
   `ProMatch-0.2.0-mac-UNSIGNED.pkg` instead, which switches on PlayerDebugMode. Don't ship one.
5. Install it on a clean machine (or a VM) with no dev junctions, and check: the panel opens,
   Capture, Auto and Apply work, the effect renders, and the uninstaller removes both. On the
   Mac, download the `.pkg` from a draft release (so it is quarantined, as for users), allow it
   as INSTALL.md says, and check the render bar is yellow.
6. Commit, tag and push the source:

   ```bash
   git commit -am "Release 0.2.0"
   ```

   ```bash
   git tag v0.2.0
   ```

   ```bash
   git push origin main --tags
   ```

7. Publish the release, with the changelog section as notes:

   ```bash
   gh release create v0.2.0 release/ProMatch-0.2.0-win-setup.exe --title "ProMatch 0.2.0" --notes-file release/release-notes.md
   ```

   Then add the Mac installer from the Mac:

   ```bash
   gh release upload v0.2.0 release/ProMatch-0.2.0-mac.pkg
   ```

   The tag must be `v` + the version. Panels see it within a day, or at once when the version
   number at the bottom of the panel is clicked.

## Dev machine notes

On the Mac, `npm run link` makes `~/Library/Application Support/Adobe/CEP/extensions/ProMatch`,
and the effect is linked as `/Library/…/MediaCore/ProMatch.plugin` → `native/out/ProMatch.plugin`
([MAC.md](MAC.md)). The `.pkg` replaces that link with a real copy, so before testing an
installer, remove the user-folder link (or Premiere sees two panels), and afterwards put both
links back; the commands are in [MAC.md](MAC.md#dev-install).

On Windows, `npm run link` makes a per-user junction `%APPDATA%\Adobe\CEP\extensions\ProMatch`, and
`native/PLAN.md` a junction `MediaCore\ProMatch` → `native\out`. With the installer also
installed, Premiere sees two copies of the panel with the same ID. Remove the junction (or
uninstall) before testing an installer build, and put it back afterwards.
