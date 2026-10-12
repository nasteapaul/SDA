---
name: crafting-apps
description: Install, update and verify the ArtCraft Crafting Apps (free open-source Rust rewrites of Adobe apps from github.com/storytold) — PhotoCraft (Photoshop), FilmCraft (Premiere Pro), EffectCraft (After Effects), VectorCraft (Illustrator), LightCraft (Lightroom), PdfCraft/PrintCraft (Acrobat), DesignCraft (InDesign). Use before any of the per-app skills (photocraft, filmcraft, effectcraft, vectorcraft, lightcraft, pdfcraft, designcraft) when a `<app>-cli` is missing, or when the user asks to install/update them.
---

# ArtCraft Crafting Apps — shared setup

All seven share one layout: a GUI binary `<app>` and a headless `<app>-cli` with a built-in MCP
server (`<app>-cli mcp`). Pure Rust, MIT OR Apache-2.0, local-only (no account, no cloud).
Stage (Oct 2026): PhotoCraft and PdfCraft early alpha, the rest in development — work on copies.

| App | Like | Repo | Tested version |
|---|---|---|---|
| PhotoCraft | Photoshop | storytold/photocraft | 0.7.0 |
| FilmCraft | Premiere Pro | storytold/filmcraft | 0.6.0 |
| EffectCraft | After Effects | storytold/effectcraft | 0.8.0 |
| VectorCraft | Illustrator | storytold/vectorcraft | 0.9.0 |
| LightCraft | Lightroom | storytold/lightcraft | 0.6.0 |
| PdfCraft (= PrintCraft) | Acrobat | storytold/pdfcraft | 0.6.0 |
| DesignCraft | InDesign | storytold/designcraft | 0.6.0 |

## Install / update (Linux, incl. cloud sessions)

If `command -v <app>-cli` fails, run (one, several, or no args = all):

```sh
bash .claude/skills/crafting-apps/install.sh photocraft pdfcraft
export PATH="$HOME/.local/bin:$PATH"
```

The script reads the latest release's `SHA256SUMS.txt`, downloads `<app>-<ver>-linux-<arch>.tar.gz`,
refuses to install on a checksum mismatch, extracts to `~/.local/opt/` and links into `~/.local/bin/`
(no root). Re-running updates to the newest release. Tell the user what will be installed first.

Network notes for cloud sessions: `github.com/<org>/<repo>/releases/.../download/...` and
raw.githubusercontent.com work through the proxy; github.com HTML pages and the REST API for repos
outside the session do not (use Firecrawl to read release pages/asset lists:
`.../releases/expanded_assets/v<ver>`).

## Other platforms (user's own computer)

- Windows: `<app>-<ver>-windows-x64.msi` (or `-portable.zip`; arm64/x86 too). Code-signed. Verify:
  `(Get-FileHash .\<file>).Hash` must equal the line in `SHA256SUMS.txt` (case-insensitive).
  SmartScreen may still warn for new software ("Windows protected your PC"): that means low download
  reputation, not malware. If the publisher shown is the ArtCraft/Storyteller team and the hash matched,
  "More info → Run anyway" is fine.
- macOS: `<app>-<ver>-macos-universal.dmg` + `<app>-cli-<ver>-macos-universal.zip`, signed and notarized.
  `shasum -a 256 -c --ignore-missing SHA256SUMS.txt`.
- Easiest for people: https://getartcraft.com/apps

No signature is published for `SHA256SUMS.txt`: the checksum proves the file is intact and matches the
release, not who built it. Explain any OS security prompt to the user in plain words before continuing.

## Rules from the apps' AGENTS.md that apply when *using* them

- MCP is opt-in: start it only when the user wants it; never register it permanently on your own.
- Give MCP/automation file access only to one dedicated work folder (`--automation-read-root` /
  `--automation-write-root`, or `--root` for PdfCraft); omitting a root denies that access.
- Live-app control channels bind to loopback with a per-launch token: never widen them or log the token.
- Drive running apps through their control channel / MCP bridge, never OS-level synthetic input.
- Verify results with the CLI's JSON (`info` / `inspect`) or a rendered PNG, then show the user.
- Cloud sessions have no display: GUIs can't open there — render PNGs instead.
- Contributing to the apps' code is a different job: read that repo's AGENTS.md first (clean-room:
  never use or copy Adobe software, code or assets; never panic on input; tests gate every change).
