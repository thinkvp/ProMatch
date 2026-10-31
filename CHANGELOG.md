# Changelog

Versions follow `major.minor.patch`. The release tag is `v` + the version (for example `v0.2.0`);
the update check compares it with the version the panel was built with.

## Unreleased

- Captures are of one camera as shot: the selected clip under the playhead (else the top one),
  with the tracks above it hidden and its ProMatch effects at 0% just for the capture. No more
  muting tracks or switching effects off by hand.
- **New match** in the toolbar starts over: frames, points and settings cleared, and the next
  Apply makes a new effect.
- Split view: drag the divider to wipe between before and after.
- Zoomed in on a 4K frame, the After view is worked out at full resolution instead of enlarged
  from the 1280-pixel preview.
- Update check: once a day the panel asks GitHub for the latest release and shows a banner when
  there is a newer one. Click the version at the bottom of the panel to check now.
- Windows installer (`npm run package:win`): installs the panel and the ProMatch effect for all
  users, and stops if Premiere Pro or Media Encoder is open.

## 0.1.0

First working build: point-pair matching, geometric and face-aware Auto, scopes, the native
ProMatch effect (CPU, CUDA, OpenCL) with the LUT stored in the project, Edit LUT round trip.
