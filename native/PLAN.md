# ProMatch native effect: plan

**Why:** a script can add Lumetri but can't give it a LUT. Every write to Lumetri's LUT state
is stored but ignored by the renderer (see `spikes/SPIKES.md`, "Hand-set LUT vs script"). A
small effect of our own, whose *numeric* parameters a script can set, turns
**Export LUT → Add Lumetri → Browse…** into one **Apply** click. It also gives live updates
and an Amount slider.

## What to install

| | Status on this PC | Action |
| --- | --- | --- |
| Visual Studio Build Tools 2022, C++ workload (MSVC 14.44, MSBuild, CMake) | **Installed** | none |
| Windows SDK 10.0.26100 | **Installed** | none |
| **Adobe After Effects SDK** (latest; Premiere hosts AE-API effects) | **Installed** (`native/sdk/Examples/`) | Download from developer.adobe.com/after-effects (needs your Adobe ID) and unzip to `F:\ProMatch\native\sdk\` (gitignored) |
| Plug-in folder link | **Done** | Once, in an **admin** prompt: `mklink /J "C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\ProMatch" "F:\ProMatch\native\out"`. After that, builds land in Premiere's plug-in folder without admin rights. |

Premiere loads effects at start-up, so each new build means restarting Premiere (the panel's
session survives that).

## The effect ("ProMatch")

As built (build 3):
- **Parameters:**
  - **Match ID** (visible): which match this is. The panel uses it to find every clip carrying a
    match, and as a fallback the effect reads `%APPDATA%\ProMatch\luts\<id>.cube`.
  - **Amount**: 0–100%, blends the original with the matched image.
  - **LUT** (no UI): the LUT itself, as text (`PMLUT1 <size> <lo> <hi> <base64>`, see
    `src/core/lut.ts` `toEmbeddedText`). Premiere saves it with the project, and setting it re-renders.
    Build 1's **Revision** slider is gone: Premiere ignores `PF_PUI_INVISIBLE`, so it was visible.
- **Render:** tetrahedral interpolation, BGRA 8u and 32f (ARGB 8 in After Effects), rows split
  across `std::thread`s. CPU only, about 5 ms per 1080p frame. A GPU path could come later; it would
  probably also remove the 0.4/255 that Premiere's CPU-effect render path adds (P7).
- **Caching:** the embedded LUT is decoded once per distinct text (content hash), the file fallback
  once per (ID, file time, size).
- **Portability:** done (P9). The project carries the LUT. The panel still writes the AppData copy
  and the copy beside the `.prproj`, for Lumetri or other apps.

## How the panel sets it

One **Apply** button (it replaced Export LUT and *fx*):
1. Write the LUT to `%APPDATA%\ProMatch\luts\<id>.cube`, plus the copy beside the project.
2. For each selected clip, and every clip in the open sequence already carrying this Match ID:
   - If it has no ProMatch effect yet, add one: QE `addVideoEffect(getVideoEffectByName("ProMatch"))`.
     QE returns an empty dummy for an unknown name, so check its `.name`.
   - Set **LUT** to the text and **Match ID** with `component.properties[i].setValue(…)`.
3. Re-apply after more tuning: the new text re-renders in place (P8, P9).
4. Not done yet: the multicam target (the angle's clip inside the multicam source sequence).

## Risks, checked in this order

1. ~~Does a script-set numeric parameter re-render?~~ **PASS (2026-10-24).** Opacity set to
   50% from script changed the capture by 17.6/255. Set back to 100%, it was pixel-identical
   again.
2. ~~Pixel encoding inside the effect.~~ **PASS (P7, 2026-10-24).** Premiere renders the effect as
   BGRA 32f and BGRA 8u, display-referred like Lumetri's LUT. On the same frame its result matches
   the software LUT to 0.44/255 (max 4, none off by more than 3). All of that gap is Premiere
   rendering the clip differently once a CPU effect is on it (Amount 0 already shows 0.40); from
   the effect's real input the LUT is exact (max 1). A GPU path could remove it; not needed.
3. ~~Render cache.~~ **PASS (P8).** A Revision bump re-renders in place. Rewriting the file
   without one leaves Premiere's cached frame. Premiere's direct export is pixel-identical to the
   Program Monitor capture, and so is a Media Encoder export (AME loads the effect itself).
4. ~~Phase 2 embedding.~~ **PASS (P9).** An arbitrary-data parameter, not sequence data. Premiere
   stores a script's string in it as UTF-16 without calling the effect's scan callback; the effect
   decodes that. It survives save and reopen, renders with no AppData file, and Media Encoder reads
   it from the project.

## Build

```bash
cmake -S native -B native/build -G "Visual Studio 17 2022" -A x64
```

```bash
cmake --build native/build --config Release
```

(`cmake` is the one in the VS Build Tools, under `Common7IDECommonExtensionsMicrosoftCMake`.)
The `.aex` lands in `native/out/`, so in Premiere's plug-in folder via the junction. Restart Premiere
to load a new build. The effect logs loads and new render setups to `%APPDATA%ProMatcheffect.log`.
`npx tsx scripts/native-check.ts` checks the C++ engine against the TypeScript one offline;
`npx tsx scripts/effect-compare.ts before.png after.png lut.cube` scores a Premiere capture.

## Rough timeline

Working in this session, with you restarting Premiere at checkpoints.

| Step | Time |
| --- | --- |
| 0. SDK download + one-time link (you) | ~15 min |
| 1. Risk 1 check (script param → re-render) | done: PASS |
| 2. Skeleton effect builds and shows up in Premiere | done (CMake + PiPLtool, `native/CMakeLists.txt`) |
| 3. LUT engine in C++ (parse, tetrahedral, 8u/32f, threads) + Amount | done (threads via `std::thread` row bands, not the AE iterate suite) |
| 4. Panel: one-click Apply, find/update an existing effect, multicam target | done, except the multicam target |
| 5. Verify: colour (P7), live update, Media Encoder export | done: P7 + P8 PASS |
| 6. Phase 2 embedding + polish | done: embedding (P9); multicam target and GPU path open |
| **Total** | **about 2.5–3.5 working days** |

A Mac build is extra (Xcode on a Mac, about a day). The C++ is written to be portable.
