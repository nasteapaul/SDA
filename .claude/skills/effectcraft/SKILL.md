---
name: effectcraft
description: Make motion graphics and visual effects with EffectCraft (open-source After Effects clone, ArtCraft) through effectcraft-cli or its MCP server — compositions, layers, keyframes, 259 effects, expressions, After Effects-style JavaScript, renders to H.264/HEVC/AV1/ProRes/WebM/PNG/EXR. Use when the user wants After Effects-style work or mentions EffectCraft.
---

# EffectCraft (After Effects) — `effectcraft-cli`

Missing? `bash .claude/skills/crafting-apps/install.sh effectcraft`. Tested: 0.8.0, 669 commands.
Project files: `.ecproj` (cannot open .aep). Global options: `--project F.ecproj | --demo | --empty`,
`--save | --save-as F`, `--bridge PORT`, `--json`, `--gpu`.

```sh
effectcraft-cli --help
effectcraft-cli commands --filter layer.new [--enabled]
effectcraft-cli info --project p.ecproj
effectcraft-cli exec layer.newSolid --params '{"name":"BG","color":"#202040"}' --project p.ecproj --save
effectcraft-cli run layer.newText '{"text":"Salut"}' layer.newNull '{}' --project p.ecproj --save
effectcraft-cli props <comp> <layer> [--flat]                # property tree with paths
effectcraft-cli get|set <comp> <layer> <path> [<value>] [--time S] [--expression E]
effectcraft-cli render-frame --demo --time 1 --max-side 480 --out f.png
effectcraft-cli render --project p.ecproj --out out.mp4 --format h264 [--start S --end S] [--resolution half]
effectcraft-cli script file.jsx p.ecproj | --eval 'app.project.numItems'     # AE-style object model
```

- `<comp>`: id or name, `-` = active comp; `<layer>`: id, `#n` or name; `<value>`: JSON or bare string.
- Useful ids: `layer.newText`, `layer.newSolid`, `layer.newShape`, `layer.newNull`, `layer.newAdjustment`, `layer.newLight`.

## MCP

`effectcraft-cli mcp [--autosave] --automation-read-root DIR --automation-write-root DIR` (headless; roots
repeatable; scripts are refused when confined), or `--bridge PORT` to a running `effectcraft --control PORT`.
GUI: `effectcraft [project]` (needs a display).
