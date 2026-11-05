# macOS

ProMatch on a Mac: the same CEP panel, the ProMatch effect as a universal `ProMatch.plugin`
(Apple Silicon and Intel), rendering on Metal or the CPU, and a `.pkg` installer. Built and
tested on an M1 with Premiere Pro 26.5.2 and macOS 14.1, 2026-11-04.

## Building

Needs the Command Line Tools (`xcode-select --install`; full Xcode isn't needed, nor its Metal
toolchain), CMake and Node, plus the **macOS** After Effects SDK and **macOS** Premiere Pro SDK
from developer.adobe.com/console (separate downloads from the Windows ones), unzipped to
`native/sdk/aesdk/` and `native/sdk/prsdk/` (gitignored).

```bash
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
```

```bash
cmake --build native/build
```

This builds `native/out/ProMatch.plugin` (universal, ad-hoc signed), `native/build/bin/lutapply`
and `native/build/bin/gputest`. The bundle is built in `native/build/plugin` and moved into
`native/out` by `mac-install.cmake`, which first moves the old one aside to `native/build/stale`.
So rebuilding while Premiere runs is safe; overwriting a loaded binary in place can crash it.

### Dev install

Once, link the effect into Premiere's plug-in folder (admin):

```bash
sudo mkdir -p "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore" && sudo ln -s "$PWD/native/out/ProMatch.plugin" "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/ProMatch.plugin"
```

and the panel (no admin; also turns on PlayerDebugMode for CSXS 9–14):

```bash
npm run link
```

Premiere loads new effects and panels at start-up, so restart it after either.

### Checks

- `npx tsx scripts/native-check.ts <frame.png> <lut.cube>`: the C++ engine against the
  TypeScript one.
- `native/build/bin/gputest <lut.cube> <frame.rgba> <w> <h> [amount]`: the Metal kernel against
  the CPU engine. It needs GPU access, so run it from Terminal, not a sandboxed shell.
- In Premiere, `scripts/cdp.mjs` drives the panel over DevTools (port 8094; `CDP_PORT=8095`
  for the helper, which can open the panel).

## Packaging

```bash
npm run package:mac
```

writes `release/ProMatch-<version>-mac.pkg` ([RELEASING.md](RELEASING.md)). Releases don't need
a Mac for this: the **Mac installer** workflow (`.github/workflows/mac-pkg.yml`) builds and
attaches the `.pkg` on a GitHub-hosted Mac ([RELEASING.md](RELEASING.md#mac-installer-on-github-actions)).
It installs the panel
to `/Library/Application Support/Adobe/CEP/extensions/ProMatch` and the effect to
`/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/ProMatch.plugin`, empties
both first (a symlink is removed, not followed), won't install while Premiere or Media Encoder
is running, and marks the bundle non-relocatable so the Installer can't redirect it to a dev
copy. No Apple Developer ID, like Syncitol and Unphased: users allow the `.pkg` once
([INSTALL.md](INSTALL.md#macos)). Files the Installer puts in place aren't quarantined, so
Premiere then loads the ad-hoc-signed effect without asking.

## What's different from Windows

| | |
| --- | --- |
| Data folder | `~/Library/Application Support/ProMatch` (panel `node.ts` `dataDir`, `helper.html`, effect `dataPath`). The helper and the effect create it if the panel hasn't run yet. |
| Paths in the effect | UTF-8 path helpers in `lut_engine.cpp` (`toUtf8`, `fromUtf8`, `openFile`); `wchar_t` is 32-bit on macOS. |
| Change LUT, Edit LUT, alerts | `mac_ui.mm` (NSOpenPanel, NSAlert) behind `mac_ui.h`. |
| GPU | Metal: `kernels/ProMatchLut.metal`, compiled from embedded source at runtime with fast math off (`metal_lut.mm`). CUDA and OpenCL are Windows-only; on an Intel Mac whose Premiere uses OpenCL, the effect renders on the CPU. |
| PiPL | Rez (`native/mac.cmake`), with both `CodeMacARM64` and `CodeMacIntel64`. |
| Panel | "Show in Finder", undo and redo on ⌘Z / ⌘⇧Z. |

## Tested (Premiere 26.5.2, M1, 2026-11-04)

On the synthetic frames from `npm run fixtures` on a test sequence:

| | Result |
| --- | --- |
| Capture | Pixel-identical to the source PNGs. |
| Auto | 8 pairs in 2.4 s, tested error 8.5 → 0.5. |
| Apply, re-Apply | The effect added with the LUT embedded; re-Apply updates it in place. |
| CPU render (before Metal) | Against the panel's software LUT: mean 0, max 1/255 at Amount 100%; mean 0.23, max 1 at 50%. |
| Metal render | Yellow render bar; 32f and 16f; mean 0, max 1/255. `gputest`: 0 difference in 32f in place, 16f src→dst, 50% and the calibration pattern; 1.8 ms per 1080p frame. |
| Change LUT, Edit LUT | Dialog in the project's `ProMatch LUTs` folder; Edit LUT reopens the panel on the match. |
| Save, close, reopen | The LUT is still in the effect and renders the same. |
| Media Encoder | Loads the effect itself, renders on Metal; PNG export mean 0, max 1/255. |
| `.pkg` | Installed on this Mac (built locally, so not quarantined): panel and effect in `/Library`, root-owned, the dev symlink for the effect removed rather than followed. With PlayerDebugMode **off**, Premiere loads the ZXP-signed panel (ThinkVP / ProMatch certificate, the Windows one) and it connects; the installed effect renders on Metal. The INSTALL.md uninstall command removes both and the receipt. |

## Not yet done

- **A downloaded install:** the `.pkg` from a GitHub (draft) release, so it's quarantined, on a
  Mac without the dev setup, to see the "can't check for malicious software" step users get.
- An Intel Mac: covered by the universal binary, untested.
- Alerts (`NSAlert`) haven't been seen in Premiere yet: Edit LUT on an effect with no match
  shows one.
