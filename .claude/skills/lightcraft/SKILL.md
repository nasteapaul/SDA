---
name: lightcraft
description: Develop and organise photos with LightCraft (open-source Lightroom clone, ArtCraft) through lightcraft-cli or its MCP server — raw development (DNG, CR2, ARW, NEF, RAF…), exposure/colour/tone sliders, presets, masks, export, HDR/panorama merge, photo libraries. Use when the user wants Lightroom-style photo editing or mentions LightCraft.
---

# LightCraft (Lightroom) — `lightcraft-cli`

Missing? `bash .claude/skills/crafting-apps/install.sh lightcraft`. Tested: 0.6.0. Non-destructive.

```sh
lightcraft-cli --help
lightcraft-cli controls                           # develop slider ids + ranges (light.exposure, wb.temp…)
lightcraft-cli commands [--json]
lightcraft-cli render in.ARW -o out.jpg --set light.exposure=0.7 --set wb.temp=5200 --size 2048 --quality 90
lightcraft-cli render in.jpg -o out.tif --preset <id> --opt bitDepth=16 --opt colorSpace=displayP3
lightcraft-cli run --import ~/Photos/a.jpg develop.set control=light.exposure value=0.7 \
    develop.auto app.export path=/tmp/a.jpg longEdge=1600
lightcraft-cli run --library DIR …                # persistent library; edits saved
lightcraft-cli merge hdr|panorama|hdr-panorama a.dng b.dng … [--preview p.png]
lightcraft-cli snapshot --demo -o ui.png          # headless full-UI screenshot (no display needed)
```

- `run`: a word without `=` starts the next command; prints `{"command","ok","result"|"error","ms"}` per command.
- Export formats: .jpg .png .tif .webp .avif .dng.

## MCP

`lightcraft-cli mcp [--library DIR | --demo] [files/folders…] [--compact]` (headless), or
`--connect` to a running `lightcraft --control 7980`. Never drive the app with OS-level synthetic input.
GUI: `lightcraft` (needs a display).
