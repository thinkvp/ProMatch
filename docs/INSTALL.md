# Installing ProMatch

## Windows

**Needs:** Windows 10 or 11 (64-bit) and Premiere Pro 2021 (15.0) or later. A GPU is optional:
the effect renders on CUDA or OpenCL when Premiere's renderer is GPU-accelerated, and on the CPU
otherwise.

1. Close Premiere Pro and Media Encoder.
2. Download `ProMatch-<version>-win-setup.exe` from the
   [latest release](https://github.com/thinkvp/ProMatch/releases/latest).
3. Run it and accept the Windows administrator prompt. The installer needs it because Premiere
   only loads effects from `Program Files`.
4. Start Premiere Pro and open **Window ▸ Extensions ▸ ProMatch**.

The installer puts two things on the computer:

| What | Where |
| --- | --- |
| The panel | `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\ProMatch` |
| The ProMatch effect | `C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\ProMatch\ProMatch.aex` |

Your sessions (`%APPDATA%\ProMatch`) and the LUTs saved beside your projects are not touched by
installing, updating, or uninstalling.

### Updating

When a new version is out, the panel shows a banner under its title bar. Press **Download** and
run the new installer over the old one; there's no need to uninstall first. To check by hand,
click the version number at the bottom right of the panel (next to **Log**).

### Uninstalling

**Settings ▸ Apps ▸ Installed apps ▸ ProMatch ▸ Uninstall.** Projects that use the ProMatch
effect still open afterwards, but those clips show as "missing effect" until it is installed
again.

### Projects on other computers

The match is stored inside the effect, so a project opens matched on any computer that has
ProMatch installed, with no LUT files to copy.

### If the panel doesn't appear

- Check **Window ▸ Extensions** after a full restart of Premiere (not just closing the project).
- If it's listed but blank, open the **Log** at the bottom of the panel and send us what it shows.
- If the effect is missing from **Effects ▸ Video Effects ▸ ProMatch**, reinstall with Premiere
  closed.

## macOS

Not available yet.
