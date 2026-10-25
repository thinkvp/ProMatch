# Changelog

Versions follow `major.minor.patch`. The release tag is `v` + the version (for example `v0.2.0`);
the update check compares it with the version the panel was built with.

## Unreleased

- Update check: once a day the panel asks GitHub for the latest release and shows a banner when
  there is a newer one. Click the version at the bottom of the panel to check now.
- Windows installer (`npm run package:win`): installs the panel and the ProMatch effect for all
  users, and stops if Premiere Pro or Media Encoder is open.

## 0.1.0

First working build: point-pair matching, geometric and face-aware Auto, scopes, the native
ProMatch effect (CPU, CUDA, OpenCL) with the LUT stored in the project, Edit LUT round trip.
