# Development

## Setup

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

## Trying it without Premiere

```bash
npm run fixtures
```

This writes two synthetic frames to `fixtures/`: the same room seen by a wide camera A and a
tighter, darker, warmer camera B. Serve the folder (e.g. `python -m http.server`), open
`index.html`, and load the two frames with **Open…**. Capture and Lumetri buttons are disabled
outside Premiere, and **Apply** downloads the LUT instead.

## Tests and evaluation

`npm test` runs the engine checks on synthetic cameras. The scripts that score settings on
saved real sessions are described in [HOW-IT-WORKS.md](HOW-IT-WORKS.md#checking-the-defaults).

## The native effect

C++ against the After Effects and Premiere Pro SDKs, in `native/`. Toolchain, SDKs and build
steps: [native/PLAN.md](../native/PLAN.md).

## Premiere API notes

Frame capture and adding the effect rely partly on Premiere's undocumented QE DOM. What was
tried and what worked is recorded in [spikes/SPIKES.md](../spikes/SPIKES.md), along with the UXP
spikes (U1–U5).

## Releasing

[RELEASING.md](RELEASING.md).
