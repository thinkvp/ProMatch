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
| P6 | _not run_ | |

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

### Premiere Pro 25.x (2025)

_Not yet run._
