# ProMatch

A Premiere Pro panel for matching the colour of one camera angle to another on multicam
interviews. You click the same things in both shots (the wall, the interviewee's skin, a red
apple on the table) and ProMatch works out how to turn the target camera's colours into the
source camera's. It shows you the result live, then puts it on the clip in one click (its own
**ProMatch** effect), and saves it as a `.cube` LUT too.

## Install (dev)

```bash
npm install
```

```bash
npm run build
```

```bash
npm run link
```

`link` junctions this folder into `%APPDATA%\Adobe\CEP\extensions\ProMatch`. Restart Premiere,
then **Window ▸ Extensions ▸ ProMatch**. DevTools: <http://localhost:8094> while the panel is open.
**Ctrl+Shift+D** shows the Developer section (API spikes); the setting is remembered.

## Using it

1. **Source.** Put the playhead on the camera you want to match *to*, then press **Capture**. It
   exports the Program Monitor frame.
2. **Target.** Switch to the camera you want to fix (same moment if possible) and press
   **Capture**. Capture it *before* putting a ProMatch LUT on it, or you will be matching
   on top of an old match.
3. **Points.** Press **Auto** for a starting set of pairs (dashed, marked *A*), including a few
   on each face. Check them and delete any that look wrong, then add a few of your own,
   especially on plain areas Auto can't reach: click something on
   the source, then the same thing on the target. Each row shows source, target and matched
   swatches, plus the error before and *tested*.

**Tested error** (the headline number and each row's pill) scores every point with a match
fitted *without* that point. It's the honest number. The fitted error can be pushed to
nearly 0 by over-tuning Fine-tune, which bends the match around each point while the image
gets worse. On a real interview, over-tuning took the fitted error from 2.39 to 0.27 while the
tested error rose from 4.66 to 7.35. Rows with a red edge and a "!" are points **the others
disagree with**: the match can't get close to them without them. They're found one at a time,
refitting after each, so one bad pick doesn't drag innocent ones in, and only with 6+ points.
Usual causes are a soft, out-of-focus background in one camera (blur mixes neighbouring
colours), a shadow or highlight on one side only, or the wrong spot. Click the number to
switch the point off and compare.
4. **Check.** Use **Before / Split / After** in the toolbar. Choose **Target** to show just
   that frame while you work in the **Settings** tab; the frames stay pinned at the top as you
   scroll.
5. **Apply.** Select the target camera's clip(s) in the Timeline and press **Apply**. ProMatch adds
   its **ProMatch** effect (Effect Controls: *Match ID*, *Amount*) or reuses the one already there.
   After more tuning press **Apply** again: every clip in the open sequence using this match
   updates in place, selected or not. The LUT is also saved to a `ProMatch LUTs` folder beside the `.prproj`, so it moves and
   gets backed up with the project (`Documents\ProMatch LUTs\` for a project never saved), for
   Lumetri or other apps. If the ProMatch effect isn't installed, Apply saves the LUT and shows the
   Lumetri **Input LUT ▸ Browse…** steps instead.

**Points:** click to place a point at the default size, or press and drag out to draw it at
any size (handy for a large flat area like a wall or a cheek). Drag inside a point to move it
(an Auto point then counts as yours). Drag its edge to resize it, and right-click or Del to
remove it. **Sample size** in Settings scales every point's circle together (−75% to +200%)
while keeping their relative sizes.

**Switching points off:** click a point's number in the list to switch it off (hollow number,
faded markers). It is left out of the match but still measured against it, so its row shows
how close the match gets at that spot *without* it. Click again to switch it back on.

**New frames:** capturing (or opening) a new source or target clears the points, since they
belonged to the old frame. **Ctrl+Z** brings them back.

**Undo:** every point change (place, draw, move, resize, delete, switch off, Auto, Clear all)
can be undone with **Ctrl+Z** or the ↶ button in the toolbar. **Ctrl+Shift+Z**, **Ctrl+Y** or
↷ redoes.

**Scopes** (toolbar button, or **S**) open a strip under the frames, visible from either tab,
so you can watch it while dragging Settings sliders. They always compare the source (blue)
with the **matched** target (amber), whatever the image view is set to. Switch on **Original**
to add the target as shot in grey and see what the match changed.
- **Hue × saturation:** an unwrapped vectorscope. Colour runs across (the strip underneath
  shows which), saturation runs up, both in Oklab so equal distances look equally different.
  Reds, skin and oranges sit together left of centre, with a dashed line at skin. Overlap shows
  as white, so where blue and amber sit apart, the cameras disagree on that colour. **2×**
  zooms 1× / 2× / 4× into the less saturated colours. Near-greys and near-blacks are left out:
  they have no meaningful hue.
- **Luma / Parade:** overlaid luma histograms with 5% / 50% / 95% ticks, or an RGB parade of
  each image side by side. The parade's across axis is each frame's own left to right, so
  compare shapes, black and white levels, and channel balance in shadows vs highlights, not
  columns.
- **Readout:** shadows, mids, highlights, saturation and hue for Source / Matched (/ Original).
  Matched values that differ enough from the source to matter are highlighted.
- **Isolate a range (Color/Gray)**, like Lumetri's HSL Secondary preview:
  - **Drag a box on the hue map** for a hue + saturation range. Starting at the bottom includes
    everything from grey up; reaching the top includes anything more colourful.
  - **Drag along the colour strip (H)** or **the bar left of the map (S)** for just hue or just
    saturation, like Lumetri's sliders.
  - **Drag across the luma scope, or up and down the parade (L)**, for a brightness range.
  - Drag a range's edge to move that edge, or inside it to move the whole range.

  Both frames then show colour only inside the range and grey elsewhere, each judged on its
  own pixels as displayed. A good match lights up the same parts of the picture in both.
  **In range** in the readout gives the share of the scoped area inside the range. A click on
  a scope clears its part of the range; **Clear range** or **Esc** clears it all. Closing the
  scopes shows the full picture again.
- **Whole frame / Matched areas / Selected point** choose what is compared. Matched areas uses
  the planes feature matching finds in both frames (face, picture, shirt), so different framing
  doesn't skew it. It can show a mismatch the whole frame hides: on the test interview, whole
  frame mids matched exactly (17 / 17) while the matched areas read 38 / 29.

**Viewing:** scroll to zoom around the cursor; **Space**+drag or middle-drag pans; the %
badge returns to fit. The eye button, or **H**, hides the points for a clean look.

**Multicam:** apply the LUT to the angle's clip *inside the multicam source sequence*. Then every
cut to that camera inherits it, and your creative grade stays on the edit as usual.

**Settings:** the match always covers exposure, contrast, white balance and each picked colour.
- **Exposure nudge** shifts the result by up to ±2 stops.
- **Per-colour fix** sets how much of the point-by-point correction is applied.
- **Fine-tune** holds *Colour range*, *Shade spread* and *Smoothing*.

Highlights always roll off into white instead of clipping, which only engages when the match
brightens past white.

The session (frames, points, settings) is saved to `%APPDATA%\ProMatch\session.json` and
restored when the panel reloads. Older sessions drop the model choice and switches they were
saved with. Colour range and Smoothing values that were still at the old defaults move to the
new ones.

## How the match works

All of it is in `src/core/`, with no dependency on Premiere or the DOM.

- **Sampling** (`sample.ts`). Each point is a disc (*Sample size*). The disc is averaged in
  linear light, and the brightest and darkest 10% are thrown out first, which removes
  speculars and edges. A patch that is more than 20% clipped is ignored and flagged in the list.
- **Global layer** (`match.ts`, in linear light). Exposure and contrast are fitted together
  as a power curve on luminance. Cameras with different picture profiles differ most in the
  darks, and on the first real test this was the biggest single error. White balance is
  per-channel gains. The engine can also fit a ridge-regressed 3×3 colour matrix for sensor
  crosstalk, but the panel doesn't offer it. On the real sessions so far it moved the picture
  by about 0.3 ΔE, and it predicted unseen points slightly worse than plain balance. A camera
  pair with real crosstalk may still need it: add it as a test case (below) and the grid will
  show it.
- **Local layer** (Oklab). Any error still left at each point is removed by a Gaussian
  radial-basis field centred on that point's colour. This is what makes *the apple's red*
  match: nearby reds (including its shadowed side, see *Shade spread*) move with it, and
  unrelated colours are left to the global layer. *Colour range* sets how far each fix reaches.
  *Smoothing* trades exactness for a gentler LUT. Shifts are capped so overlapping,
  disagreeing points can't overshoot.
- **Auto, geometric** (`features.ts`, `homography.ts`, `geo-auto.ts`). Puts pairs at the
  *same physical spot* in both frames, so you can check them by eye:
  - OpenCV's AKAZE matches keypoints on contrast-equalised greyscale.
  - RANSAC splits the matches into planes (face, picture, shirt...).
  - Each plane is searched for flat, unclipped spots near its own matches. Each spot is mapped
    through the plane and must be flat in the other frame too. Up to 16 pairs, picked for
    colour variety.
  - **Faces** (`faces.ts`) get up to 6 skin pairs each from a face mesh: OpenCV's YuNet finds
    each face, and MediaPipe's face mesh puts 468 landmarks on it. Landmark *n* is the same spot
    on the face in both frames (middle of the forehead, the cheekbone), whatever the angle.
    Pairs come from open skin only (forehead, cheeks, nose bridge, chin), and only where the
    face points towards both cameras: the far cheek of a turned head is skipped. Each disc is
    sized to the face. With one face in each frame they're paired directly; with several, the
    planes decide which face is which.
  - Pairs whose colours disagree with the consensus are dropped.

  It needs some texture: bare walls and plain sofas give it nothing to match, so pick those by
  hand. OpenCV.js (11 MB, `vendor/opencv.js`, copied by `npm run build`) and the face models
  (`vendor/face_detection_yunet_2023mar.onnx`, 230 KB, from the
  [OpenCV model zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), MIT;
  `vendor/face_landmark.tflite`, 1.2 MB, from [MediaPipe](https://github.com/google-ai-edge/mediapipe),
  Apache 2.0) load only the first time you press Auto. If the face models fail to load, Auto
  carries on without skin pairs.
- **Auto, colour** (`auto.ts`). The fallback when too few features match. It clusters the
  source frame's colours and iteratively aligns the target's colours to them. It improves the
  fit, but its pairs can land on different objects that share a colour.

Scores on the two saved test cases (on hand-placed points each method never saw; lower is
better):

| | 7 points | 11 points |
| --- | --- | --- |
| No correction | 9.95 | 9.35 |
| Colour Auto | 4.31 | 4.68 |
| Geometric Auto, 10 pairs, no faces (before 2026-10-25) | 3.12 | 4.28 |
| Geometric Auto, 16 pairs + 6 on the face | 3.22 | **3.12** |
| ... + 3 manual points | 3.23 | 3.18 |

On the 11-point frame Auto alone now beats 10 hand-placed points alone (3.78). On the 7-point
frame skin was already well covered; its worst points are the sofa and the picture mat, which
feature matching can't reach (the sofa is out of focus in the close-up).

`npx tsx scripts/eval-real.ts` reruns the comparison on the current session's hand-placed
points; set `EVAL_SESSION` to score a saved point set instead.
- **Output** (`lut.ts`). The result is evaluated on a 17³, 33³ or 65³ grid and written as an
  Adobe/Resolve `.cube`. If the match brightens the image, a highlight roll-off eases values
  into white instead of clipping. It is invisible below 85% and off when nothing goes past
  white.

### Checking the defaults

**Save as test case** (Points tab, in Premiere; shown in Developer mode, **Ctrl+Shift+D**) copies both frames and your own points into
`%APPDATA%\ProMatch\eval\`. Two scripts score settings on every saved case, always on points
the fit never saw. They use two kinds of point: your own, each left out in turn, and a few
hundred same-spot pairs that feature matching finds away from them.
- `npx tsx scripts/eval-options.ts` changes one setting at a time. For each it gives the error
  and how much the whole matched frame changes, i.e. whether the setting does anything visible.
- `npx tsx scripts/eval-grid.ts` searches combinations and lists the best.

The current defaults came from this: white balance (no matrix), colour range 0.15 and
smoothing 0.1. On unseen points they score 3.91 ΔE, against 4.35 for the earlier matrix, 0.12
and 0.03. The evidence so far is one camera pair, so add test cases from other cameras and
lighting before trusting the defaults further.

`npm test` checks the engine against synthetic second cameras with known errors: exposure,
white balance, crosstalk and a red-only hue twist. For example, at its tightest (matrix, narrow
colour range) the apple's error goes from ΔE 11.6 to 0.1, while an unrelated blue moves less
than 1. With the smoother defaults it goes to 1.4.

## Trying it without Premiere

```bash
npm run fixtures
```

This writes two synthetic frames to `fixtures/`: the same room seen by a wide camera A and a
tighter, darker, warmer camera B. Serve the folder (e.g. `python -m http.server`), open
`index.html`, and load the two frames with **Open…**. Capture and Lumetri buttons are disabled
outside Premiere, and **Apply** downloads the LUT instead.

## The ProMatch effect

A small native effect (C++, the After Effects effect API, which Premiere hosts) in `native/`. It
applies the match with tetrahedral interpolation, 8-bit and 32-bit, blended by *Amount*. The LUT
is stored **inside the effect**, so it is saved with the project and opens matched on another
computer that has the effect installed, with nothing to copy. Each Apply replaces it, which
re-renders. It renders on the GPU (CUDA; OpenCL too) when Premiere's renderer is GPU-accelerated,
and on the CPU otherwise. On the test interview, the GPU render matches the panel's After view to
0.25/255 (the CPU render to 0.44/255), and Media Encoder exports are pixel-identical to the Program
Monitor (spikes P7–P10). Build and install: `native/PLAN.md`.

In Effect Controls it shows **Amount** and two rows:
- **LUT**, on a button showing the LUT's file name: click it to pick another `.cube` from the project's `ProMatch LUTs`
  folder; it is stored in the effect. A LUT saved by ProMatch still knows its match; any other
  LUT is on its own (and isn't calibrated for a scene-referred sequence).
- **Edit LUT** opens the ProMatch panel on the match that made the LUT: both frames, the points
  and the settings. Every Apply keeps them in `ProMatch LUTs\Matches\<name> [<id>]\`. Press
  **Apply** after changing it and every clip using the match updates. A small invisible helper
  (`helper.html`) opens the panel when it is closed.

## Not verified yet

The Premiere-side calls (frame capture, adding Lumetri, setting the LUT) use undocumented QE DOM
and are listed in [spikes/SPIKES.md](spikes/SPIKES.md). Run them and record the results there.

## Roadmap

- **Multicam target.** Apply to the angle's clip inside the multicam source sequence directly.
- **Multicam angle capture.** Enumerate the angles of the selected multicam clip and capture
  each one directly, without switching angles by hand.
- **Shot-to-shot.** Save a match per camera pair and reapply it across interviews shot with the
  same setup.
