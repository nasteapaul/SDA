---
name: photocraft
description: Edit images with PhotoCraft (open-source Photoshop clone, ArtCraft) through photocraft-cli or its MCP server — layers, masks, adjustments, filters, type, PSD/PSB, PNG/JPG/TIFF/WebP/EXR, batch actions. Use when the user wants Photoshop-style image editing or mentions PhotoCraft.
---

# PhotoCraft (Photoshop) — `photocraft-cli`

Missing? `bash .claude/skills/crafting-apps/install.sh photocraft` (see the crafting-apps skill).
Tested: 0.7.0, 858 engine commands. Every menu item is a command id; never guess ids.

```sh
photocraft-cli --help                                  # all subcommands; <sub> --help
photocraft-cli commands --filter adjust                # ids, labels, menu paths (--json for params)
photocraft-cli info in.psd [--compact]                 # JSON: size, mode, depth, layer tree
photocraft-cli convert in.psd out.png [--quality 90] [--tiff-layers]
photocraft-cli run in.png --cmd filter.blur.gaussianBlur --params '{"radius":4}' --out out.png
photocraft-cli run in.psd --cmd layer.new.layer --params '{"name":"Ink"}' \
                          --cmd image.adjustments.exposure --params '{...}' --out out.psd
photocraft-cli run --new '{"width":800,"height":600}' --cmd document.inspect
photocraft-cli batch --actions actions.json --in raw/ --out done/ --format jpg   # --in-place to overwrite
photocraft-cli droplet file.pcdroplet img-or-dir… [--out dir]
photocraft-cli serve [--port N]                        # headless JSON-lines session
```

- `run` prints one JSON line per command; check each for `error`. `--params` applies to the preceding `--cmd`.
- Formats: .pcraft (native, lossless), .psd/.psb, .png, .jpg, .tif, .webp, .exr …
- Useful ids: `image.adjustments.{levels,curves,exposure,hueSaturation,brightnessContrast,desaturate}`,
  `filter.blur.gaussianBlur`, `filter.sharpen.smartSharpen`, `layer.newAdjustmentLayer.curves`, `document.inspect`.

## MCP

Headless: `photocraft-cli mcp --automation-read-root DIR --automation-write-root DIR`
(`claude mcp add photocraft -- "$(command -v photocraft-cli)" mcp --automation-read-root ~/photocraft-work --automation-write-root ~/photocraft-work`).
Live app: `photocraft --control 7878 --control-token-file <private> --automation-read-root DIR --automation-write-root DIR`,
then `photocraft-cli mcp --bridge 127.0.0.1:7878 --control-token-file <private>`.
Tools: `doc_open/new/save/export/inspect/render_preview/select/close`, `command_list`, `command_run`,
`command_batch`, `jobs_list/cancel`, `session_list`; bridge only `ui_inspect/screenshot/pointer/menu_invoke/set`, `control_call`.
Loop: `doc_open` → `command_list{filter}` → `command_run`/`command_batch` → `doc_inspect` → `doc_export`.

GUI: `photocraft [file]` (needs a display). Wayland: no drag-and-drop yet; use File › Open.
