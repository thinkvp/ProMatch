# Using ProMatch

Installing: [INSTALL.md](INSTALL.md). How the match is computed: [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## The steps

1. **Source.** Put the playhead on the camera you want to match *to*, then press **Capture**.
2. **Target.** Put it on the camera you want to fix (same moment if possible) and press
   **Capture**.

   A capture is of one camera, as it comes in: the clip under the playhead that's selected (even
   on a hidden track), else the top visible one. For that instant, the tracks above it are
   hidden and its ProMatch effects set to 0%, then put back. So with both cameras stacked,
   select one, capture, select the other, capture; and recapturing a clip that already has its
   match never matches on top of it. Its Lumetri and other effects stay in.
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

**New match** (toolbar, click twice): starts over for another pair of cameras. It clears both
frames and the points and puts every setting back to its default; the next Apply makes a new
effect. Clips you already matched keep theirs, and its **Edit LUT** brings that match back.

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
badge returns to fit. The eye button, or **H**, hides the points for a clean look. In **Split**, drag the divider or its round grip to wipe between before
and after; double-click it to centre it.

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

## The ProMatch effect

A small native effect (C++, the After Effects effect API, which Premiere hosts) in `native/`. It
applies the match with tetrahedral interpolation, 8-bit and 32-bit, blended by *Amount*. The LUT
is stored **inside the effect**, so it is saved with the project and opens matched on another
computer that has the effect installed, with nothing to copy. Each Apply replaces it, which
re-renders. It renders on the GPU (CUDA; OpenCL too) when Premiere's renderer is GPU-accelerated,
and on the CPU otherwise. On the test interview, the GPU render matches the panel's After view to
0.25/255 (the CPU render to 0.44/255), and Media Encoder exports are pixel-identical to the Program
Monitor (spikes P7–P10). The installer puts it in place ([INSTALL.md](INSTALL.md)); building it
from source: [DEVELOPMENT.md](DEVELOPMENT.md#the-native-effect).

In Effect Controls it shows **Amount** and two rows:
- **LUT**, on a button showing the LUT's file name: click it to pick another `.cube` from the project's `ProMatch LUTs`
  folder; it is stored in the effect. A LUT saved by ProMatch still knows its match; any other
  LUT is on its own (and isn't calibrated for a scene-referred sequence).
- **Edit LUT** opens the ProMatch panel on the match that made the LUT: both frames, the points
  and the settings. Every Apply keeps them in `ProMatch LUTs\Matches\<name> [<id>]\`. Press
  **Apply** after changing it and every clip using the match updates. A small invisible helper
  (`helper.html`) opens the panel when it is closed.
