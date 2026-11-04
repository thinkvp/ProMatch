# Handover: finish the Mac port on the Windows PC

Written 2026-11-04 on the Mac, at the end of the session that built the macOS version. The Mac
work is on the `mac` branch, in [pull request #1](https://github.com/thinkvp/ProMatch/pull/1)
(`mac` → `main`, not merged). What was built and tested on the Mac: [MAC.md](MAC.md). Delete this
file in the release commit.

## Where things stand

- **Mac:** done and tested in Premiere 26.5.2 on an M1: panel, universal effect with Metal, and a
  signed `.pkg` (ZXP-signed with `certs/promatch.p12`, same certificate as Windows).
- **Windows:** not compiled since the Mac changes. The C++ shared with the Mac build changed, so
  that's the first job here.
- **Releases:** there are none on GitHub yet, so the README's "latest release" link leads nowhere
  for either platform.

## 1. Check the Windows build (on the PC)

```bash
git fetch && git checkout mac && npm install
```

Build the effect as [native/PLAN.md](../native/PLAN.md) says (the junction already puts it in
Premiere's plug-in folder), then:

```bash
npm run typecheck && npm test
```

```bash
npx tsx scripts/native-check.ts
```

```bash
native\build\bin\Release\gputest.exe <lut.cube> <frame.rgba> <w> <h>
```

`native-check` now finds the data folder through `scripts/data-dir.ts`; on Windows that is still
`%APPDATA%\ProMatch`.

What changed in the shared C++, so where a compile error or a behaviour change would be:

| File | Change |
| --- | --- |
| `native/src/lut_engine.cpp/.h` | New `toUtf8`, `fromUtf8`, `openFile`, `fileExists` (Windows: `WideCharToMultiByte`, `_wfopen`, `GetFileAttributesW`), used by `dataPath`, `lutFolder` and `logLine`. `logLine` now creates `%APPDATA%\ProMatch` (`CreateDirectoryW`) if it is missing. |
| `native/src/ProMatch.cpp` | `PickCube` and a new `Alert` behind `#ifdef _WIN32` (macOS versions in `mac_ui.mm`); `RequestEdit` and the Change LUT handler are no longer Windows-only. `Utf8()` replaced by `pm::toUtf8`. Edit LUT's `at` field is now epoch ms (`std::chrono`) instead of `GetTickCount64`; the panel only watches the file's mtime. |
| `native/src/ProMatch_GPU.cpp` | CUDA and OpenCL code inside `#ifdef _WIN32`; Metal in the `#else`. |
| `native/src/gpu_api.h`, new `gpu_args.h` | `LutKernelArgs` moved to `gpu_args.h` (with a `static_assert` that it is 64 bytes); `gpu_api.h` includes it. |
| `native/CMakeLists.txt` | `find_program(PiPLtool)` moved below the Mac branch; non-MSVC compile options added; the macOS build is in `native/mac.cmake` (not used on Windows). |

Then in Premiere on the PC: open the panel with it left open from last time (it should say
"Connecting…" briefly, never "Host script failed"), Capture, Auto, **Apply**, **Change LUT**,
**Edit LUT** (with the panel closed too), and check the render bar is yellow (CUDA). The
`effect.log` in `%APPDATA%\ProMatch` should read as before.

If anything needs fixing, commit it to `mac` and push; the pull request picks it up.

## 2. Merge

When Windows checks out:

```bash
gh pr merge 1 --repo thinkvp/ProMatch --merge --delete-branch
```

## 3. First release (0.2.0, both installers)

Follow [RELEASING.md](RELEASING.md). In short:

1. On the PC, on `main`: rename **Unreleased** in `CHANGELOG.md` to `0.2.0`, delete this file,
   then:

   ```bash
   npm run version:set 0.2.0
   ```

2. Build the effect, `npm test`, then:

   ```bash
   npm run package:win
   ```

3. Install-test it (RELEASING.md step 5), commit "Release 0.2.0", tag `v0.2.0`, push, and create
   the release with the `.exe` (RELEASING.md step 7).
4. **Back on the Mac** (the `.pkg` can only be built there; it needs the macOS SDKs and
   `certs/`, both already in place on the Mac):

   ```bash
   git checkout main && git pull
   ```

   ```bash
   cmake --build native/build && npm run package:mac
   ```

   ```bash
   gh release upload v0.2.0 release/ProMatch-0.2.0-mac.pkg
   ```

   Before uploading, check the Mac dev links are in place (MAC.md "Dev install"), or remove
   them if you install-test the `.pkg`.

## Still untested on Mac

- Installing a `.pkg` downloaded from GitHub (quarantined), to see the security prompt users get.
  Worth doing once the release exists, on a Mac without the dev setup.
- An Intel Mac (the binary is universal).
- The effect's alert boxes (Edit LUT on an effect with no match shows one).
