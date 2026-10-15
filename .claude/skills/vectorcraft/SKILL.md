---
name: vectorcraft
description: Make and convert vector art with VectorCraft (open-source Illustrator clone, ArtCraft) through vectorcraft-cli or its MCP server — artboards, paths, shapes, type, Pathfinder, image trace; reads/writes SVG, PDF, AI, EPS, DXF, EMF, PSD, PNG/JPG/WebP. Use when the user wants Illustrator-style vector work or file conversion, or mentions VectorCraft.
---

# VectorCraft (Illustrator) — `vectorcraft-cli`

Missing? `bash .claude/skills/crafting-apps/install.sh vectorcraft`. Tested: 0.9.0. Native: `.vectorcraft`.

```sh
vectorcraft-cli --help
vectorcraft-cli commands                          # full catalogue as JSON (id, label, menu, params)
vectorcraft-cli info art.svg                      # import warnings, colour mode, artboards, counts, fonts
vectorcraft-cli convert in.ai out.svg [--outline-text] [--artboard 0 | --range "1-3"] [--scale 2]
vectorcraft-cli run [--in FILE] --cmd ID --params '{…}' [--cmd …] --export out.pdf [--export out.png]
```

- Readable: .vectorcraft .svg .svgz .pdf .ai .ait .eps .dxf .emf .wmf .psd .psb .png .jpg .gif .webp .tif .bmp .af/.afdesign/.afpub.
- Writable: .vectorcraft .svg .svgz .pdf .ai .eps .dxf .emf .wmf .psd .png .jpg .gif .webp .tif .bmp .tga .txt.
- `convert` refuses OUT == IN when reading lost something, unless `--replace-lossy`.
- Without `--in`, `run` starts a new document (`file.new` params: `width`, `height`, `units`, `artboards`…).

## MCP

`vectorcraft-cli mcp` connects to a running `vectorcraft --control 7979`, else runs headless.
Confined headless: `vectorcraft-cli mcp --automation-read-root DIR --automation-write-root DIR`.
GUI: `vectorcraft [file]` (needs a display).
