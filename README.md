# ProMatch

A Premiere Pro panel for matching the colour of one camera angle to another on multicam
interviews. You click the same things in both shots (the wall, the interviewee's skin, a red
apple on the table) and ProMatch works out how to turn the target camera's colours into the
source camera's. It shows you the result live, then saves it as a `.cube` LUT for Lumetri.

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
3. **Points.** Press **Auto** for a starting set of pairs (dashed, marked *A*). Check them and
   delete any that look wrong, then add two or three of your own on skin: click something on
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
5. **Export LUT.** The file goes to a `ProMatch LUTs` folder beside the `.prproj`, so it moves
   and gets backed up with the project. A project that has never been saved falls back to
   `Documents\ProMatch LUTs\`. The path is copied. In Lumetri Color go to
   **Basic Correction ▸ Input LUT ▸ Browse…** and paste the path.
   **Add Lumetri to selected clips** saves a step.

**Points:** click to place a point at the default size, or press and drag out to draw it at
any size (handy for a large flat area like a wall or a cheek). Drag inside a point to move it
(an Auto point then counts as yours). Drag its edge to resize it, and right-click or Del to
remove it. **Sample size** in Settings scales every point's circle together (−75% to +200%)
while keeping their relative sizes.

**Switching points off:** click a point's number in the list to switch it off (hollow number,
faded markers). It is left out of the match but still measured against it, so its row shows
how close the match gets at that spot *without* it. Click again to switch it back on.

**Undo:** every point change (place, draw, move, resize, delete, switch off, Auto, Clear all)
can be undone with **Ctrl+Z** or the ↶ button in the toolbar. **Ctrl+Shift+Z**, **Ctrl+Y** or
↷ redoes.

**Viewing:** scroll to zoom around the cursor; **Space**+drag or middle-drag pans; the %
badge returns to fit. The eye button, or **H**, hides the points for a clean look.

**Multicam:** apply the LUT to the angle's clip *inside the multicam source sequence*. Then every
cut to that camera inherits it, and your creative grade stays on the edit as usual.

The session (frames, points, settings) is saved to `%APPDATA%\ProMatch\session.json` and
restored when the panel reloads.

## How the match works

All of it is in `src/core/`, with no dependency on Premiere or the DOM.

- **Sampling** (`sample.ts`). Each point is a disc (*Sample size*). The disc is averaged in
  linear light, and the brightest and darkest 10% are thrown out first, which removes
  speculars and edges. A patch that is more than 20% clipped is ignored and flagged in the list.
- **Global layer** (`match.ts`, in linear light). Exposure and contrast are fitted together
  as a power curve on luminance. Cameras with different picture profiles differ most in the
  darks, and on the first real test this was the biggest single error. White balance is
  per-channel gains. Then a 3×3 colour matrix handles sensor and profile
  crosstalk. The matrix is ridge-regressed toward the plain exposure × balance diagonal, so one
  or two points give a sensible exposure + balance match rather than a made-up matrix.
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
    through the plane and must be flat in the other frame too.
  - Pairs whose colours disagree with the consensus are dropped.

  It needs some texture: bare walls and plain sofas give it nothing to match, so pick those by
  hand. OpenCV.js (11 MB, `vendor/opencv.js`, copied by `npm run build`) loads only the first
  time you press Auto.
- **Auto, colour** (`auto.ts`). The fallback when too few features match. It clusters the
  source frame's colours and iteratively aligns the target's colours to them. It improves the
  fit, but its pairs can land on different objects that share a colour.

Scores on real footage (on points each method never saw; lower is better):

| | ΔE |
| --- | --- |
| No correction | 9.95 |
| Colour Auto | 4.35 |
| Geometric Auto | 2.85 |
| Geometric Auto + 3 manual points | 2.81 |

`npx tsx scripts/eval-real.ts` reruns the comparison on the current session's hand-placed
points; set `EVAL_SESSION` to score a saved point set instead.
- **Output** (`lut.ts`). The result is evaluated on a 17³, 33³ or 65³ grid and written as an
  Adobe/Resolve `.cube`. If the match brightens the image, an optional highlight roll-off
  eases values into white instead of clipping. It is invisible below 85% and off when nothing
  goes past white.

`npm test` checks the engine against synthetic second cameras with known errors: exposure,
white balance, crosstalk and a red-only hue twist. For example, the apple's error goes from
ΔE 11.6 to 0.1, while an unrelated blue moves less than 1.

## Trying it without Premiere

```bash
npm run fixtures
```

This writes two synthetic frames to `fixtures/`: the same room seen by a wide camera A and a
tighter, darker, warmer camera B. Serve the folder (e.g. `python -m http.server`), open
`index.html`, and load the two frames with **Open…**. Capture and Lumetri buttons are disabled
outside Premiere, and **Export LUT** downloads the file instead.

## Not verified yet

The Premiere-side calls (frame capture, adding Lumetri, setting the LUT) use undocumented QE DOM
and are listed in [spikes/SPIKES.md](spikes/SPIKES.md). Run them and record the results there.

## Roadmap

- **One-click apply.** If spike P5 shows Lumetri's LUT can be set from script, Export can apply
  it directly. If it can't, the clean route is a small native effect (AE/Premiere SDK, C++),
  "ProMatch Apply", which reads the `.cube` by ID. That also gives live updates and an amount
  slider. It needs Visual Studio Build Tools and the Adobe After Effects SDK, neither of which
  is on this machine yet.
- **Multicam angle capture.** Enumerate the angles of the selected multicam clip and capture
  each one directly, without switching angles by hand.
- **Shot-to-shot.** Save a match per camera pair and reapply it across interviews shot with the
  same setup.
