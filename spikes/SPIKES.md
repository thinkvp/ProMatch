# Premiere API spikes

Same rule as Interviewed: **nothing may depend on an API until it has a PASS here** for the
Premiere versions we ship against. ProMatch's colour maths is fully tested offline
(`npm test`); everything below is the part that only Premiere can answer.

Run P5 from the panel's **Developer** section: press **Ctrl+Shift+D** to show it, and select one clip first. The others are
observed by just using the panel.

| ID | Question | Why it matters | Fallback if it fails |
| --- | --- | --- | --- |
| P1 | QE `exportFramePNG(timecode, path)`: does it write the file? Does it add `.png` itself? How long does it take? | This is how frames are captured | **Open…** a still exported by hand (File ▸ Export ▸ Frame) |
| P2 | Does the captured frame include effects on the clip (Lumetri, our LUT)? | Expected YES — so the TARGET must be captured before its ProMatch LUT is applied, or the match fits on top of itself | Bypass the effect (fx toggle) while capturing |
| P3 | Multicam: in the edited sequence, does the export show the active angle? | Lets the user capture A and B by switching angles at one playhead | Capture from inside the multicam source sequence with the other tracks hidden |
| P4 | QE `addVideoEffect(getVideoEffectByName("Lumetri Color"))` lands on the right clip when the track has gaps | DOM clip index → QE item index skips "Empty" items | Add Lumetri by hand |
| P5 | **Can script set Lumetri's Input LUT / Look to a file path?** (`PM_trySetLut`) | YES = **Export LUT** can become one-click apply | Manual Browse… (current behaviour), or the native effect in the README roadmap |
| P7 | The native ProMatch effect (`native/`) renders the LUT the same way: its frame matches the software LUT | Risk 2 in `native/PLAN.md`: an AE-API effect may get other pixel values than Lumetri under colour management, especially in 32-bit | Note the format and values it gets (`effect.log`) |
| P8 | Does **Apply** after more tuning update the picture (Revision bump), in the Program Monitor and in exports? | Risk 3: Premiere caches rendered frames by parameter values, not by the LUT file | A visible parameter the user nudges |
| P10 | Can the effect render on the GPU (Premiere's GPU filter API), reading the embedded LUT? | Playback without GPU→CPU→GPU copies; the CPU path also shifts the input by 0.4/255 (P7) | CPU path only |
| P9 | Can the effect carry the LUT itself (an arbitrary-data parameter set from script), so a project opens matched on another machine? | Phase 2 of `native/PLAN.md`: portability, and no Revision slider | Keep reading `%APPDATA%\ProMatch\luts` and copy the LUTs by hand |
| P11 | Effect build 8: does Premiere show a button parameter (`PF_Param_BUTTON`) in Effect Controls, send `PF_Cmd_USER_CHANGED_PARAM` when it is clicked (the effect opens a file dialog and stores the chosen `.cube`), and show the parameter's new name from `PF_UpdateParamUI` (the LUT's name)? | Pick a different LUT from Effect Controls, and see which LUT a clip uses | Show and change the LUT from the panel instead |
| P6 | Lumetri reads our `.cube` (TITLE, DOMAIN_MIN/MAX, sizes 17/33/65) and the result in the Program Monitor matches the panel's **After** view | Confirms the LUT is applied in the encoding the engine assumes (display-referred Rec.709) | If it differs, the sequence's colour management is converting first — note the settings here |

## Results

### Premiere Pro 26.3.2 (2026)

Test project "PROMATCH-TEST": two-camera interview, 111_3933.MXF (close-up) and C0773.MP4 (wide).
The panel was driven over its DevTools port with `node scripts/cdp.mjs "<expr>"`.

| ID | Verdict | Notes |
| --- | --- | --- |
| P1 | **PASS** | Wrote 1920×1080 PNGs. **Appends `.png` itself** (we pass a bare path). Done within about 1 s; the panel's poll for a stable file size handles the async write. |
| P2 | _not run_ | |
| P3 | PARTIAL | A second run captured 111_3933.MXF and C0773.MP4 at the **same** playhead (00:01:36:07), and the clip-under-playhead label named each one correctly. How the view was switched between them (multicam angle or track visibility) was not recorded. |
| P4 | **PASS** | "Added Lumetri Color to 1 clip(s)" on C0773.MP4. Tested on one clip only; a track with gaps is not covered. |
| P5 | PARTIAL, open | See below. |
| P6 | **PASS** | Same frame: Premiere's Input LUT result matches the panel's software prediction to 0.27/255 (S-Log3 media, gamma 2.2 project). See below. |
| P7 | **PASS** | The native ProMatch effect, applied by **Apply**: Premiere's frame matches the panel's software LUT to **0.44/255** on the same frame (max 4, no value off by more than 3). See below. |
| P10 | **PASS** | GPU path (CUDA) inside the same effect: renders on the GPU in Premiere and Media Encoder, matches the software LUT to **0.25/255** (max 2), and Amount 0 is identical to no effect. See below. |
| P9 | **PASS** | The LUT is embedded in the effect and saved with the project: after save + restart it renders with no AppData file, exact to the software LUT (max 1/255). See below. |
| P8 | **PASS** | Re-apply after tuning re-renders in place through the Revision bump; rewriting the LUT file without a bump does not. See below. |

**P5 detail (first run, broad spike — tried every param matching /LUT\|Look/).** On a fresh Lumetri:

| Param | Read before | setValue(path) | Read after |
| --- | --- | --- | --- |
| Input LUT (×2) | `0` (number) | **"Illegal Parameter type"** | `0` |
| Look (×2) | `0` (number) | **"Illegal Parameter type"** | `0` |
| Embedded LUTs | `ﺾ`-looking string | accepted | the path |
| Media Embedded LUT type | `""` | accepted | the path |
| Media Embedded Lut blob | `ﺾ`-looking string | accepted | the path |
| LUTAsset | `ﺾ`-looking string | accepted | the path |
| LookAsset | `ﺾ`-looking string | accepted | the path |

So the **Input LUT / Look dropdowns are numeric popups** and refuse a path. Five hidden string or
blob params accept any string and read it back. **Not known: whether any of them changes the
picture.** Reading back the same string only proves the store, not the effect. Writing a path into
the blob params may also have left that Lumetri instance in an odd state.

**API survey, 26.3.2 (read-only, via `reflect`).**
- `app.project.applyLumetriPreset(name: string) → boolean`, `getAllLumetriPresetsList()` and
  `getLumetriPresetsForFolderList(category)` cover only Premiere's 331 built-in Look presets
  (categories like "SpeedLooks" and "Filmstocks", from `Lumetri/LUTs/Creative/*.itx`). They do
  not see `.cube` files in our folder or in `Common/LUTs`, so they can't apply a ProMatch LUT
  without installing it into Program Files and restarting.
- ProjectItem has `getInputLUTID` / `getEmbeddedLUTID` but **no setter**, so a clip-level
  Input LUT is out.
- `Sequence.renderVideoFrameAtTime` and `renderVideoFrameAtTimeWithColorSpace` exist. They're an
  official alternative to QE `exportFramePNG` for capture.
- The source clip reports colour space **Sony S-Log3/S-Gamut3.Cine** (scene-referred). Whether
  Lumetri applies a LUT before or after colour management's conversion to display decides
  whether our display-referred LUT is correct (P6). Unverified.

**LUTAsset alone: no effect (2026-10-24).** C0773.MP4 was selected in PROMATCH-TEST at
00:03:30:03. The test captured the frame, added a fresh Lumetri, set only `#128 LUTAsset` to a
test `.cube` (accepted and read back), then captured again. **The two captures are identical to
the pixel.** Applying the same LUT to the before frame in software changes it by 30/255 on
average, so the LUT is clearly not being applied. A dump afterwards shows why: both
`Input LUT` dropdowns (#6, #7) still read `0` (None), and they refuse strings. Next step: Browse…
a LUT by hand once, then dump to see which dropdown index and `LUTAsset` format Premiere itself
writes, and set those two from script.

**Hand-set LUT vs script (2026-10-24, same clip, all captures at 00:03:30:03).**
- Browse… by hand sets `#6 Input LUT` to `1` and leaves `LUTAsset` empty. The real state is the
  XML in `#0 Blob`: UTF-8 packed two bytes per UTF-16 code unit, starting `<Lumetri>`. It holds
  `<shader name="LUT"> <__Embed>"1"</__Embed> <LUT>"C:\…ile.cube"</LUT>` plus an
  `<embeddedlut><hash>…</hash><filename>…</filename>`. `#122 Embedded LUTs` holds that hash,
  the size and an `ITX3` tag. Premiere embeds its own converted copy, so the hash isn't the
  file's MD5. The LUT shader is followed by "Gamma 2.4 to Linear", so the LUT sees display
  gamma values.
- **Script cannot change what Lumetri renders.** Every write is accepted and reads back, but
  the capture is pixel-identical to the hand-set state each time. Tried: `#6` 1 → 0 → 1;
  `LUTAsset` = a greyscale test LUT with `#6` at 1; and the full XML rewritten to the grey LUT
  (path, `__Embed` 0, no hash), including after a playhead nudge to force a re-render.
- **Gotcha: the evalScript bridge silently drops some code units**, e.g. U+2061, which is what
  "a" + space packs into. The first blob writes were corrupted that way ("Gamma 2.4" became
  "Gamm2.4"). Sending the code units as hex and rebuilding with `String.fromCharCode` inside
  ExtendScript round-trips exactly. The decisive grey test was redone that way: still no
  change. The test Lumetri's XML was restored byte-identical afterwards.
- **P6 PASS: the LUT is applied in the encoding the engine assumes.** Same frame, before vs
  hand-set LUT: Premiere's output matches our software application of the same `.cube` to the
  captured frame to **0.27/255 on average, 0% of values off by more than 3**, flat across
  brightness. That holds with S-Log3 source media under Premiere colour management in a
  gamma 2.2 project. A first attempt suggested a highlight mismatch; it was the playhead
  having moved between captures.
- Consequence for one-click: script can add Lumetri but not give it a LUT. Options are a native
  effect (AE SDK) whose numeric parameter script *can* set, or the current Browse… step.
  Re-exporting under the same name does not update a Lumetri that already uses it, because
  the LUT is embedded; it has to be picked again.

**Native-effect risk 1 PASS (2026-10-24): script-set parameters re-render.** On C0773 at
00:03:30:03, `Opacity.properties[0].setValue(50, true)` changed the capture by 17.6/255 on
average (it blended with the camera on the track below). `setValue(100, true)` restored it
pixel-identically. So ordinary effect parameters are fully scriptable; only Lumetri's private
LUT state isn't. The one-click native-effect plan (`native/PLAN.md`) stands.

**Next run (spike tooling now supports it):**
1. Delete the Lumetri the first spike wrote into. Add a fresh one, then set the LUT **by hand**
   (Basic Correction ▸ Input LUT ▸ Browse…) and run **Dump effects**. The full dump goes to
   `%APPDATA%\ProMatch\spikes\`. It shows the popup index and what `LUTAsset` and the
   embedded blobs hold when Premiere sets them itself.
2. On a fresh Lumetri, set only what Premiere set, one param at a time. Use **Params to set**
   (names, or `#index` for the duplicate names) and **Value** (blank = the last LUT; a number goes
   to a popup). Check the Program Monitor after each.

**Sampling experiment (2026-10-24, same project, 16 user-placed points at 00:03:30:03).**
I tried "smart regions" (a magic-wand flood fill from each click, sampling the whole patch) as
the default pick. Scored leave-one-out against disc samples at the user's points:
careful picks gave disc 3.27 / region 3.36. Picks nudged ±15 px gave disc 3.37 / region
3.88. Sweeping region radius 25–160 px and tolerance 0.04–0.07 stayed within ±0.2 of discs.
The cause: lighting varies across a surface, and the two cameras see different parts of it,
so a large region averages a lighting gradient the other camera does not share. **Not
shipped.** Discs stay the pick method.

**Auto by geometry, not colour (2026-10-24).** Auto v1 pairs colours, not places: "6A" can
be the sofa in one frame and a wall sign in the other. It still improves the fit, but nobody
can sanity-check pairs like that. `spikes/feature-match.ts` tested classic feature matching
(OpenCV.js 4.12 AKAZE on CLAHE-equalised greyscale, ratio test 0.8, sequential RANSAC
homographies at 4 px) on the same two frames. Keypoints 1655 / 2109, 243 matches, **0.5 s**.
It found four planes: face + collar (62 inliers), the picture frame (40), the shirt (38), and
a dubious 18-inlier group. Visual check in `captures/feature-match.png`: the first three map
the same physical points across the 2.5× zoom and angle change. Plain areas (bare wall, sofa)
get no matches. Cost: `opencv.js` is 10.9 MB and would be loaded only when Auto runs.

**Shipped as Auto v2.** Scored on 7 hand-placed points from the first capture pair
(`%APPDATA%\ProMatch\eval\first-run-7pts.json`; the user's 16 points were cleared before this
run). Colour Auto scored 4.35 alone and 4.42 with 3 manual points. Geometric Auto scored
**2.85** alone and **2.81** with 3 manual points. No correction was 9.95. A visual check of
all 10 pairs on the 00:03:30:03 frames found each pair on the same spot: forehead, temple,
cheek, chin, four on the picture, the frame corner and the shirt pocket. Inside Premiere
26.3.2 it found 243 matches in 3 areas and made 10 pairs in 1.7 s on first use (OpenCV load
included), 0.7 s after that.
Gotcha found there: the project's `"type": "module"` made CEP's Node refuse
`require(vendor/opencv.js)` as an ES module. Fixed with `vendor/package.json` setting
`"type": "commonjs"`.

Also found in this run:
- `app.name` is **undefined** in ExtendScript, so the status line read "undefined 26.3.2". Now falls back to "Premiere Pro".
- Real cameras differ in **contrast**, not just exposure and colour. With the same 7 points, the
  old exposure + matrix model got a mean ΔE of 2.45, and the picture mat got *worse* (3.1 → 6.7).
  The contrast stage fitted 1.84, left the matrix close to plain white balance, and brought the
  mean to 1.93. `npx tsx scripts/match-session.ts` re-runs a saved session offline and writes
  `captures/compare.png`.

**Native effect P7 + P8 (2026-10-24, Premiere 26.3.2, same clip and frame).** The test Lumetri was
deleted from C0773 first (with the user's OK), so the before frame is ungraded.
- **Loading.** `ProMatch.aex` (AE effect API, built with the AE SDK, see `native/`) loads from the
  MediaCore junction after a Premiere restart: `effect.log` shows `GlobalSetup host=PrMr api=13.4`, and
  ProMatch is in `qe.project.getVideoEffectList()` (150 effects). Gotcha:
  **`qe.project.getVideoEffectByName()` never returns null.** For an unknown name it returns an empty
  object whose `name` is `""`, and `addVideoEffect` then returns `false`. Check `.name`.
- **Apply.** One click added the effect to the selected C0773 (matchName `AE.PRMT ProMatch`) and set
  `Match ID` 1168498 and `Revision` 1. The **Revision** param is hidden in the UI (`PF_PUI_INVISIBLE`) but
  scripting still lists it, reads it and sets it.
- **Pixel format (risk 2).** Premiere renders the effect both as **BGRA_4444_32f** and as BGRA_4444_8u around
  each capture; which of the two produced the captured frame is not established. Rows are bottom-up (`rowbytes` -30720 / -7680).
- **P7 PASS.** Same frame (00:03:30:03), capture without the effect vs with it: the effect moved values by
  25.8/255 on average. Premiere's frame vs the same `.cube` applied in software to the before capture:
  **0.44/255 mean**, max 4, 5% of values off by more than 1, **none off by more than 3**. By brightness
  (dark → bright): 0.21, 0.40, 0.57, 0.53, 0.56. **The gap is not the LUT.** With the effect at Amount 0
  (in the chain, changing nothing) the capture already differs from the no-effect frame by 0.40/255 (max 4):
  Premiere renders the clip slightly differently once a CPU-only effect is on it, probably by using its
  software path instead of the GPU. Predicted from that Amount 0 frame (the effect's real input),
  Premiere's output equals the software LUT: **mean 0.000, max 1**. Amount 50% vs prediction: 0.48/255
  (same input gap). A GPU render path for the effect might remove the 0.4; it isn't visible as it is.
  The panel preview and `applyLutToPixels` were switched from trilinear to **tetrahedral**, the effect's
  interpolation, so the After view is what Apply renders. On the real LUT the two differ by 0.064/255 on
  average, but by up to 5/255 on a steep synthetic LUT. Tetrahedral is also closer to the model
  (worst ΔE 0.31 vs 0.51 on the 33³ test).
- **P8 PASS.** With +0.5 stop exposure in the panel, rewriting `<id>.cube` **without** a Revision bump left
  the capture pixel-identical to the old one (Premiere served its cached frame). Then **Apply** (same ID,
  Revision 2) matched the tuned LUT in software to 0.51/255 (max 5, none off by more than 3). Setting it back and
  applying again (Revision 3) was pixel-identical to the first result.
- Gotcha: **QE `exportFramePNG` needs backslashes.** A forward-slash path throws "Unknown error exception".
- Engine check offline (`scripts/native-check.ts`): the C++ engine equals the TypeScript tetrahedral
  reference to ±1 rounding, 8u and 32f, at Amount 1 and 0.5; 1080p in 4.6 ms on this PC.
- **Exports (P8).** One frame (in/out set on 00:03:30:03, then restored to unset):
  `Sequence.exportAsMediaDirect` with the PNG Sequence preset took 0.8 s, and **Media Encoder**
  (`app.encoder.encodeSequence` + `startBatch`) loaded its own copy of the effect (a second
  `GlobalSetup` in `effect.log`, rendering BGRA 8u). Both frames are **pixel-identical** to the Program
  Monitor capture. Gotcha: with a wrong preset path `encodeSequence` still returns a job ID and AME's
  queue just resumes and stops; `exportAsMediaDirect` reports "Preset file doesn't exist".

**Native effect P9: embedded LUT (2026-10-24, builds 2 and 3, same clip and frame).** The effect got
an arbitrary-data parameter "LUT" (no UI, can't be keyframed), and Revision was dropped: Premiere shows
`PF_PUI_INVISIBLE` params anyway, so build 1's Revision slider was visible in Effect Controls.
- **How Premiere fills it (build 2 probe, every callback logged).** `component.properties[i].setValue(string)`
  on the arb param does **not** call the effect's SCAN callback. Premiere stores the JS string itself as the
  data, **UTF-16LE, no terminator** (287,528 chars → `UNFLATTEN` of 575,056 bytes), and `getValue()` returns
  it unchanged (no PRINT call). So a read-back proves storage, not parsing. Build 2 expected its own
  binary format, rejected the bytes and quietly fell back to the AppData file.
- **Build 3** keeps those bytes as they are and decodes them when rendering (cached by a content hash). The
  text is `PMLUT1 <size> <lo> <hi> <base64 of uint16 LE>` (`toEmbeddedText` in `src/core/lut.ts`): 281 KB
  for 33³ (the .cube is 948 KB), 0.002/255 from the .cube. The effect accepts ASCII too, for hosts that do
  call SCAN.
- **Save + reopen:** the project saved with build 2's instance reopened under build 3 with
  `lut=embedded 33` on its first renders.
- **No AppData file** (every `.cube` moved out of `%APPDATA%\ProMatch\luts`): at 100% Premiere equals the
  software LUT applied to the effect's input (the Amount 0 frame), **mean 0.000, max 1**. At Amount 50% (a fresh
  render), max 1/255.
- **Re-apply without Revision:** +0.5 stop then Apply changed the frame by 10.8/255 and matched the tuned LUT
  exactly (max 1). Setting it back and applying was pixel-identical to the earlier capture. Setting
  the text is a parameter change, so Premiere re-renders.
- **65³** (2.2 MB of text through `evalScript` and `setValue`): Apply 0.59 s (33³: 0.14 s), render exact (max 1).
- **Exports** read the LUT from the project, too: a one-frame `exportAsMediaDirect` and a Media Encoder export
  (AME loaded build 3 itself, `lut=embedded 33`) are both pixel-identical to the Program Monitor capture.

**Native effect P10: GPU path (2026-10-24, builds 4–6, RTX 4070, driver 617.42).**
- **Renderers.** `qe.project.getRendererNames()` lists Software Only, CUDA and OpenCL; **no DirectX** on this
  PC. The project uses **CUDA** (`qe.project.currentRendererName`). The Premiere SDK guide says Premiere
  dropped OpenCL in 2021 ("entirely CUDA/Metal"), though the option is still listed. So the GPU filter
  has CUDA and OpenCL kernels and no DirectX one.
- **How it plugs in.** `ProMatch.aex` also exports `xGPUFilterEntry` (Premiere SDK `PrGPUFilterModule`);
  Premiere pairs it with the CPU effect in the same file. `Initialize` declines a device it can't run on
  (then Premiere renders that instance on the CPU). CUDA: `ProMatchLut.cu` compiled to PTX by nvcc
  (CUDA 13.4, `compute_75`, PTX ISA 9.4) and embedded; OpenCL: `ProMatchLut.cl` embedded as source.
  Both are reached through `nvcuda.dll` / `OpenCL.dll` at runtime (`native/src/gpu_api.h`), so the
  plug-in has no new DLL dependencies. A driver too old for the PTX makes the filter decline (logged).
- **LUT on the GPU side (build 4 probe).** `GetParam` on the arbitrary-data param returns type 10
  (`kPrParamType_PrMemoryPtr`), the same 575,056 bytes of UTF-16 text, and **a new pointer on every
  read**, so the plug-in owns it and must `PrDisposePtr` it (build 4 leaked; fixed in build 5). It is
  read once per GPU instance; Premiere makes a new instance when a parameter changes.
- **Offline** (`native/build/bin/Release/gputest.exe`, real frame, 33³): CUDA and OpenCL vs the CPU
  engine are **bit-identical in 32f** and within one half-float step (0.12/255) in 16f, in place and
  src→dst, Amount 1 and 0.5. Kernel time per 1080p frame: OpenCL 0.10 ms, CUDA about 0.2 ms
  (CPU engine about 5 ms, plus Premiere's GPU→CPU→GPU copies).
- **In Premiere (build 6, CUDA renderer):** log `GPU: filter ready on device 0 (CUDA)`, frames 32f, in place.
  - **Amount 0 is identical** to the clip without the effect (mean 0.000, max 1): the CPU path's 0.40/255
    shift (P7) is gone, because the frame never leaves the GPU.
  - **100% vs the software LUT on the no-effect frame: 0.25/255** (max 2, none over 1), down from 0.44 on the
    CPU path and level with Lumetri's 0.27 (P6). The rest is the GPU working on unrounded float input
    while the prediction starts from an 8-bit capture. Amount 50%: 0.32 (max 2).
  - **Re-apply after tuning** (+0.5 stop): the frame changed by 10.7/255 and matched the tuned LUT to 0.29/255
    (max 2). Back to the original setting: pixel-identical to the first GPU capture.
  - **Exports:** one-frame `exportAsMediaDirect` and Media Encoder (which loaded build 6 and rendered on CUDA
    itself) are pixel-identical to the Program Monitor capture.
- **Not checked:** the OpenCL path inside Premiere (needs the project renderer switched), 16f frames inside
  Premiere (it only handed this effect 32f), and playback dropped frames, GPU vs CPU path.

**P11, effect build 8 (2026-10-25, LUT button).** Premiere shows the `PF_Param_BUTTON`; a click
sends `PF_Cmd_USER_CHANGED_PARAM` (index 3) and the effect's Windows file dialog opens over Premiere.
Premiere sends `PF_Cmd_UPDATE_PARAMS_UI` when Effect Controls shows the effect, and
`PF_UpdateParamUI` renaming the button returned no error: the button read "ProMatch match" (the
label for a build-7 LUT with no name). Not yet known: loading a picked `.cube` (the dialog was
cancelled), and whether the renamed *name* or the button *text* is what Premiere draws; build 9 sets
them apart (name = the LUT's name, text = "Change LUT") inside a "ProMatch LUT" group, with an
Edit LUT button beside it.

### Premiere Pro 25.x (2025)

_Not yet run._

## UXP spikes (U1–U5)

Can a UXP panel do what the CEP panel does? Adobe made UXP GA in Premiere 25.6. It will stop
accepting new CEP submissions in Dec 2027, disable CEP by default in Dec 2028 and remove it in
Dec 2029. The spike panel is in `spikes/uxp/` (build its extras with `node spikes/uxp/build.mjs`).
Load it with the UXP Developer Tools (**Add Plugin** → `spikes/uxp/manifest.json` → **Load**), then
open it from **Window → UXP Plugins**. Each button writes `spikes/uxp/out/results.json`.

| ID | Question | Replaces |
| --- | --- | --- |
| U1 | `Exporter.exportSequenceFrame` writes the frame at the playhead, identical to the CEP capture | QE `exportFramePNG` |
| U2 | The panel can read and write pixels, run `src/core`, and run WebAssembly (OpenCV for Auto) | Canvas 2D `ImageData`, OpenCV.js |
| U3 | `VideoFilterFactory.createComponent` + `createAppendComponentAction` adds the ProMatch effect | QE `addVideoEffect` |
| U4 | `ComponentParam.createSetValueAction` sets the effect's LUT (arbitrary-data, text) and Match ID, and Premiere re-renders | ExtendScript `setValue` |
| U5 | The LUT survives save and reopen | — |

### Premiere Pro 26.3.2, UXP Developer Tools 2.3.0.5 (2026-10-24)

Project MyMax - OMP30, sequence PROMATCH-TEST, playhead 00:01:49:00 on C0773.MP4.
U1 and U2 were run with the user's go-ahead; U3–U5 need a scratch project.

- **U1 PASS.** PNG and BMP at 1920×1080 are **pixel-identical** to the CEP panel's QE capture of the
  same frame (0/255, max 0), in about 0.25 s for PNG and 12 ms for BMP.
  - **The folder must use backslashes:** `exportSequenceFrame(seq, time, "uxp-frame.png",
    "F:\…\out\\", w, h)`. With forward slashes it returned `false` and wrote nothing. Passing a full
    path as the filename failed the same way.
  - In the first run it returned `true` with forward slashes but still wrote nothing. So check that
    the file exists; don't trust the return value.
- **U2: the engine passes, pixels are partial, WebAssembly fails.**
  - **`src/core` runs unchanged** (bundled by esbuild as a global): fit plus a 33³ LUT bake in
    30 ms, `toEmbeddedText` gives the same 287,528 characters as Node. `btoa`/`atob` exist.
  - **Canvas has no pixel access.** `getContext('2d')` exists, with `fillRect`, but there is no
    `getImageData`, `putImageData`, `createImageData` or `drawImage`, and no `ImageData`,
    `createImageBitmap`, `OffscreenCanvas`, `DecompressionStream` or `TextEncoder`. The panel's frame
    views, loupe, scopes and Color/Gray all draw pixels, so none of that ports as is.
  - **Pixels can come in through BMP:** Premiere's BMP export decodes in plain JS (24-bit, bottom-up)
    in 15 ms for 1080p. Reading is solved. *Showing* pixels still needs another way: a WebView, an
    `<img>` of a file the panel writes, or a Hybrid (C++) plugin.
  - **WebAssembly: FAIL (so far).** `WebAssembly` exists, but instantiating a 41-byte module never
    settled (no result after 20 s+). OpenCV.js, and with it geometric Auto, would need a Hybrid
    plugin or a JS-only matcher.
  - **The first run crashed Premiere** (Adobe crash reporter). That run did canvas, BMP, core,
    WebAssembly, then `require` of the 11 MB `opencv.js` and a WebView, with results written only
    at the end, so the cause isn't known. The second run (checkpointed, ending at WebAssembly) didn't
    crash. Suspects: the OpenCV `require` or the WebView. Those are now buttons 2b and 2c, to run in a
    scratch project.
- **U2c PASS: a WebView gives the panel a full browser.**
  - It needs `"allowLocalRendering": "yes"` in the manifest's `webview` permission. Without it, local
    pages (`plugin:/…`, `file:`) fail with "Navigation disallowed", although `https://example.com`
    loads.
  - With it, `plugin:/webview.html` loads in about 0.3 s. The WebView is Edge WebView2 (Chrome 155):
    Canvas 2D `putImageData` → `getImageData` round-trips, and `WebAssembly` exists.
    `window.uxpHost.postMessage` reaches the plugin as a `message` event on the `<webview>`.
  - So the CEP panel's UI could run nearly as is inside a WebView, with the UXP side doing the
    Premiere calls and file access over the message bridge. OpenCV inside the WebView is likely but
    not yet tested.
- **U2b (OpenCV in UXP itself): not run.** It's the suspect for the first crash. With the WebView
  route, OpenCV would load there instead.
- **U3 PASS.** `VideoFilterFactory.getMatchNames()` lists `AE.PRMT ProMatch`. `createComponent`
  plus `chain.createAppendComponentAction`, inside `project.lockedAccess` +
  `executeTransaction`, appended a second ProMatch effect to C0773 (index 3), with its parameters
  Match ID, Amount and LUT. The frame export after it worked.
- **U4: FAIL for the LUT, and it crashed Premiere.**
  - **Reading the LUT:** `getValueAtTime` throws "not supported for these value types. Use
    GetKeyframeAtTime".
  - **Setting the LUT:** `createKeyframe(<287 KB text>)` throws **"Illegal Parameter type"**. UXP's
    keyframes take number, string, boolean, PointF or Color, but not the effect's arbitrary-data
    parameter, even as text.
  - **Match ID:** `createKeyframe(4242)` threw "The script object is no longer valid", because the
    parameter object went stale across the awaits in between. Fixed in the spike by building actions
    from fresh objects; that version never got to run.
  - **The crash:** the next version first read every parameter with `getStartValue()`, and Premiere
    crashed (crash reporter at 22:35:11) before anything was recorded. That is most likely
    `getStartValue()` on the arbitrary-data LUT parameter. Not proven: it could have been Match ID's
    or Amount's.
- **U5: not run.**

### UXP verdict (2026-10-24)

**A port is possible, but not a straight one, and one-click Apply as built today doesn't survive it.**

| Need | UXP | Notes |
| --- | --- | --- |
| Frame capture | **Yes** | `exportSequenceFrame`, identical pixels; backslash folder path |
| Matching engine (`src/core`) | **Yes** | Unchanged |
| Pixel UI (frames, loupe, scopes, Color/Gray) | **Only in a WebView** | UXP canvas has no pixel access; a WebView is full Chromium |
| OpenCV (Auto) | **Probably, in the WebView** | Not in UXP's own runtime (WebAssembly never settled) |
| Add our effect | **Yes** | `createComponent` + append action |
| Set the embedded LUT | **No** | "Illegal Parameter type"; reading it crashed Premiere |

Options for Apply under UXP:
1. **The LUT file by Match ID.** UXP sets only the numeric Match ID (to be confirmed), and the effect
   reads `%APPDATA%\ProMatch\luts\<id>.cube`, which it already supports as a fallback. This loses
   portability (P9): the project no longer carries its LUT, so the files must travel with it.
2. **Keep the embedded LUT, set from ExtendScript.** ExtendScript isn't part of the CEP removal,
   but a UXP plugin may not be able to call it. To check.
3. **Wait for Adobe** to support arbitrary-data parameters in UXP, and report the crash.

**Recommendation:** stay on CEP for now, since it works and is supported until 2028–29. Keep the
port plan as "WebView UI + UXP host + Apply by option 1 or 2". Re-run U4 on each new Premiere
release.

## Auto v3: more pairs and face landmarks (2026-10-25)

Scored with `scripts/eval-real.ts` on the two saved test cases (7 and 11 hand-placed points, same
camera pair), fitted on Auto's pairs alone and scored on the hand points. Before: 3.12 / 4.28 ΔE.

- **More pairs.** 10 → 16 plane pairs, and planes from 12 matches instead of 20 (up to 6 planes:
  this adds a fourth area of 13–17 matches on these frames). Combined mean over the 18 points
  3.80 → 3.43. Past ~20 the score stops improving and moves ±0.3 from one setting to the next,
  which is the noise floor of 18 points.
- **The face models run inside OpenCV.js 4.12** (`@techstark/opencv-js`), under Node and in the
  panel: `cv.FaceDetectorYN` with YuNet (2023mar ONNX) and `cv.readNetFromTFLite` with MediaPipe's
  `face_landmark.tflite`. The mesh's output comes back as `[1, 1404, 1, 1]` (468 × xyz); input is
  an NCHW blob, RGB 0..1, 192×192. Detection 0.25 s at 960 px wide (0.9 s at 1080p), mesh 0.04 s.
  On both frames the mesh puts the eyes, mouth, forehead, cheeks and chin on the same spots
  across the 3/4 close-up and the frontal wide (checked by eye on crops).
- **Skin pairs.** Combined mean with 2 / 4 / 6 skin pairs per face: 3.39 / 3.15 / 3.04. The
  11-point case gains most (3.66 → 2.97). The 7-point case doesn't move: its skin was already
  matched, and its worst points are the sofa (soft focus in the close-up, so no matches) and the
  picture mat.
- **Discs sized to the object in each frame** (smaller on the wide shot, sized to the face for
  skin): 3.08 vs 3.04, no measurable gain. Kept so each pair is sampled with the disc it was
  checked flat with.
- **Plane spots on a face with a mesh dropped**: 3.16 vs 3.08, within noise. Kept: the face had
  10 overlapping labels, and the slots go to the rest of the frame.
- **Shipped:** 16 plane pairs + 6 per face. `eval-real`: 3.22 / **3.12** alone (was 3.12 / 4.28),
  3.23 / 3.18 with 3 manual points. In the panel (browser preview, same frames): 22 pairs, 6 on
  the face, 1.4 s.
- Not covered: two or more people in frame (the planes decide which face is which; untested on
  real footage), and faces small enough that YuNet misses them in a wide shot.
