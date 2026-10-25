# Releasing

Two repositories:

| Repo | Visibility | Holds |
| --- | --- | --- |
| [thinkvp/ProMatch](https://github.com/thinkvp/ProMatch) | Private | The source (this repo) |
| [thinkvp/ProMatch-releases](https://github.com/thinkvp/ProMatch-releases) | Public | Installers, release notes, and the user docs only |

The panel's update check (`src/panel/update.ts`) asks GitHub's API for the latest release
without signing in. GitHub answers **404** to that for a private repo, and a token baked into
the panel would be readable by anyone who installs it. So releases go to the public repo, which
holds no source.

## One-time setup

- **Inno Setup 6:** `winget install JRSoftware.InnoSetup`.
- **ZXPSignCmd** (signs the panel so Premiere loads it without PlayerDebugMode): download
  `ZXPSignCmd-64bit.exe` from
  [Adobe-CEP/CEP-Resources ▸ ZXPSignCMD](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD)
  and save it as `tools/ZXPSignCmd.exe` (gitignored), or put it on `PATH`.
- **Certificate:** the first signed build creates a self-signed one at `certs/promatch.p12`
  (gitignored) with the password in `ZXP_CERT_PASSWORD`. Keep it and the password safe (a
  password manager, plus a backup of the file): every later release should be signed with the
  same certificate.
- **The effect:** see `native/PLAN.md` for the SDKs and toolchain.

## Each release

1. Update `CHANGELOG.md`: rename **Unreleased** to the new version.
2. Set the version (package.json and `CSXS/manifest.xml` together):

   ```bash
   npm run version:set 0.2.0
   ```

3. Build and test the effect (`native/PLAN.md`), then run the checks:

   ```bash
   npm test
   ```

4. Build the installer. With `ZXP_CERT_PASSWORD` set in the environment:

   ```bash
   npm run package:win
   ```

   This writes `release/ProMatch-0.2.0-win-setup.exe`. A build without ZXPSignCmd is
   **unsigned** and switches on PlayerDebugMode on the user's machine; it says so loudly. Don't
   ship one.
5. Install it on a clean machine (or a VM) with no dev junctions, and check: the panel opens,
   Capture, Auto and Apply work, the effect renders, and the uninstaller removes both.
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

7. Publish the release on the **public** repo, with the changelog section as notes:

   ```bash
   gh release create v0.2.0 release/ProMatch-0.2.0-win-setup.exe --repo thinkvp/ProMatch-releases --title "ProMatch 0.2.0" --notes-file release-notes.md
   ```

   The tag must be `v` + the version. Panels see it within a day, or at once when the version
   number at the bottom of the panel is clicked.

## Dev machine notes

`npm run link` makes a per-user junction `%APPDATA%\Adobe\CEP\extensions\ProMatch`, and
`native/PLAN.md` a junction `MediaCore\ProMatch` → `native\out`. With the installer also
installed, Premiere sees two copies of the panel with the same ID. Remove the junction (or
uninstall) before testing an installer build, and put it back afterwards.
