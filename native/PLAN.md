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
| **Adobe After Effects SDK** (latest; Premiere hosts AE-API effects) | missing | Download from developer.adobe.com/after-effects (needs your Adobe ID) and unzip to `F:\ProMatch\native\sdk\` (gitignored) |
| Plug-in folder link | missing | Once, in an **admin** prompt: `mklink /J "C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\ProMatch" "F:\ProMatch\native\out"`. After that, builds land in Premiere's plug-in folder without admin rights. |

Premiere loads effects at start-up, so each new build means restarting Premiere (the panel's
session survives that).

## The effect ("ProMatch")

- **Parameters** (all numeric, so a script can set them):
  - **Match ID**: which LUT to use, read from `%APPDATA%\ProMatch\luts\<id>.cube`.
  - **Amount**: 0–100%, blends the original with the matched image.
  - **Revision** (hidden): the panel bumps it after re-exporting a LUT, so Premiere drops its
    cached frames and re-renders. That gives live updates.
- **Render:** parse `.cube` (17/33/65), tetrahedral interpolation, 8-bit and 32-bit float
  BGRA, multithreaded via the AE iterate suite. CPU only; for a 3D LUT at 1080p/4K that's
  plenty. A GPU path can come later if playback needs it.
- **Caching:** the LUT is parsed once per (ID, revision), not per frame.
- **Portability:** phase 1 reads the LUT from AppData, and the panel also keeps a copy beside
  the `.prproj`, as now. Phase 2 embeds the LUT data in the effect (flattened sequence data or
  an arbitrary-data parameter) so the project opens with the match intact on another machine,
  like Lumetri's embedded LUTs.

## How the panel sets it

**Export LUT** and **fx** become one **Apply** button:
1. Write the LUT to `%APPDATA%\ProMatch\luts\<id>.cube`, plus the copy beside the project.
2. For each target clip (selected clips, or the target angle's clip inside a multicam source
   sequence):
   - If it has no ProMatch effect yet, add one: QE `addVideoEffect(getVideoEffectByName("ProMatch"))`.
     Adding effects this way already works (spike P4).
   - Set **Match ID** and bump **Revision** with `component.properties[i].setValue(…)`.
3. Re-apply after more tuning: same ID, new revision, and the picture updates in place.

## Risks, checked in this order

1. ~~Does a script-set numeric parameter re-render?~~ **PASS (2026-10-24).** Opacity set to
   50% from script changed the capture by 17.6/255. Set back to 100%, it was pixel-identical
   again.
2. **Pixel encoding inside the effect.** Lumetri's LUT sees display-gamma values (P6 PASS).
   A third-party effect under Premiere's colour management may get different values,
   particularly in 32-bit. Rerun the same-frame harness from P6 against the effect (P7).
3. **Render cache:** confirm a Revision bump forces a re-render, in the Program Monitor and in
   exports through Media Encoder.
4. **Phase 2 embedding:** Premiere's handling of sequence data is quirkier than After
   Effects'. Prototype before relying on it.

## Rough timeline

Working in this session, with you restarting Premiere at checkpoints.

| Step | Time |
| --- | --- |
| 0. SDK download + one-time link (you) | ~15 min |
| 1. Risk 1 check (script param → re-render) | done: PASS |
| 2. Skeleton effect builds and shows up in Premiere | ~half a day (most of the unknowns: PiPL resource build, loading) |
| 3. LUT engine in C++ (parse, tetrahedral, 8u/32f, threads) + Amount | ~half a day |
| 4. Panel: one-click Apply, find/update an existing effect, multicam target | ~half a day |
| 5. Verify: colour (P7), live update, Media Encoder export | ~half a day |
| 6. Phase 2 embedding + polish | ~half to one day |
| **Total** | **about 2.5–3.5 working days** |

A Mac build is extra (Xcode on a Mac, about a day). The C++ is written to be portable.
