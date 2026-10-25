# How the match works

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

## Checking the defaults

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
