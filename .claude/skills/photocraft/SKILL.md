---
name: photocraft
description: Install, verify and drive PhotoCraft (open-source Photoshop clone from ArtCraft / github.com/storytold) through its photocraft-cli or MCP server. Use when the user wants to edit images with PhotoCraft, install or update it, or run photocraft-cli. Same pattern applies to the sibling Crafting Apps (FilmCraft, EffectCraft, VectorCraft, LightCraft, PdfCraft/PrintCraft, DesignCraft).
---

# PhotoCraft (ArtCraft Crafting Apps)

Source: `storytold/photocraft` AGENTS.md, README.md and docs/development.md at v0.7.0 (2026-10-11).
Pure Rust, native egui/wgpu app; MIT/Apache-2.0. Stage: early alpha — keep originals, work on copies.

## Install (always verify)

1. Latest release: `https://github.com/storytold/photocraft/releases/latest`. The asset list lives at
   `.../releases/expanded_assets/v<ver>`; download `SHA256SUMS.txt` from the same release.
   Release downloads (`/releases/download/...`) and raw.githubusercontent.com work through the cloud proxy;
   the github.com API outside the session's repos does not.
2. Pick the asset for the machine:
   - Windows x64: `photocraft-<ver>-windows-x64.msi` (or `-portable.zip`); arm64/x86 variants exist. Code-signed.
   - macOS: `photocraft-<ver>-macos-universal.dmg` + `photocraft-cli-<ver>-macos-universal.zip` (signed, notarized).
   - Linux x86_64: `.tar.gz` (contains `bin/photocraft` and `bin/photocraft-cli`), `.AppImage`, `.deb`, `.rpm`, `.flatpak`.
3. Verify before installing: `sha256sum -c --ignore-missing SHA256SUMS.txt` (Linux),
   `shasum -a 256 -c --ignore-missing SHA256SUMS.txt` (macOS),
   `(Get-FileHash .\file -Algorithm SHA256).Hash` vs the line in SHA256SUMS.txt (Windows PowerShell).
   No signature file (.sig/.asc) is published for SHA256SUMS.txt — the checksum proves the download is
   intact, not who made it; trust comes from GitHub + the code-signing.
4. Tell the user what will be installed and explain any OS security prompt (SmartScreen, Gatekeeper)
   in plain words before proceeding.
5. Linux tarball, no root: extract to `~/.local/opt/` and symlink both binaries into `~/.local/bin/`.

## CLI (`photocraft-cli`)

Every UI action is an engine command (500+), callable by id from the CLI, control channel and MCP.

```sh
photocraft-cli --help                       # every subcommand explains itself (<sub> --help)
photocraft-cli commands --filter blur       # list command ids + params
photocraft-cli info file.psd                # JSON: size, mode, depth, layer tree
photocraft-cli convert in.psd out.pcraft    # any supported format -> any
photocraft-cli run in.png --cmd layer.new.layer --params '{"name":"Ink"}' \
                          --cmd filter.blur.gaussianBlur --params '{"radius":3}' --out out.psd
photocraft-cli run --new '{"width":800,"height":600}' --cmd document.inspect
photocraft-cli batch --actions actions.json --in photos/ --out done/ --format jpg
photocraft-cli serve [--port N]             # headless JSON-lines session
```

- `run` prints one JSON line per command result — check each for errors.
- `batch` refuses `--out` == `--in` unless `--in-place`. Actions file: `[["<id>", {...}], ...]` or
  `[{"command":"<id>","params":{...}}, ...]`.
- Look up exact ids/params with `commands --filter <word>` before running; never guess ids.
- Verify edits with `info` / `document.inspect` (layer tree, effects, adjustments) rather than screenshots.

## MCP server

Headless (no file access unless roots are given — use one dedicated work folder):

```sh
mkdir -p ~/photocraft-work
claude mcp add photocraft -- "$(command -v photocraft-cli)" mcp \
  --automation-read-root ~/photocraft-work --automation-write-root ~/photocraft-work
```

Live app bridge: `photocraft --control 7878 --control-token-file <private> --automation-read-root <dir> --automation-write-root <dir>`,
then `photocraft-cli mcp --bridge 127.0.0.1:7878 --control-token-file <private>`.

Tools: `session_list`, `doc_open/new/save/export/inspect/render_preview/select/close`,
`command_list`, `command_run`, `command_batch`, `jobs_list`, `jobs_cancel`;
bridge only: `ui_inspect`, `ui_screenshot`, `ui_pointer`, `ui_menu_invoke`, `ui_set`, `control_call`.
Loop: `doc_open` → `command_list{filter}` → `command_run`/`command_batch` → `doc_inspect` → `doc_export`/`doc_save`.

## Open the app

`photocraft [file]` (desktop GUI; needs a display). On Wayland drag-and-drop doesn't work yet — use
File › Open or `WAYLAND_DISPLAY= photocraft`. Cloud sessions have no display: there, use the CLI only.

## Contributing (only if asked to change PhotoCraft's code)

Read AGENTS.md first. Key rules: Rust only, no Tauri/webview; never panic on input; no `unsafe`;
everything is an engine command; no sRGB/u8 assumptions; clean-room (never copy Adobe code/assets);
tests gate every change (`cargo test`, `cargo clippy -D warnings`, `cargo xtask layers`, `cargo xtask wasm`).
