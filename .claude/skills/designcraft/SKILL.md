---
name: designcraft
description: Lay out pages with DesignCraft (open-source InDesign clone, ArtCraft) through designcraft-cli or its MCP server — frames, threaded text, styles, swatches, master pages, export to PNG and print-ready PDF/PDF-A, IDML exchange. Use when the user wants InDesign-style page layout or mentions DesignCraft.
---

# DesignCraft (InDesign) — `designcraft-cli`

Missing? `bash .claude/skills/crafting-apps/install.sh designcraft`. Tested: 0.6.0 (~4.5k commands).

```sh
designcraft-cli --help
designcraft-cli commands [FILTER]                   # JSON: id, label, enabled, disabled_reason
designcraft-cli describe COMMAND
designcraft-cli run --sample --export out.png       # built-in sample document
designcraft-cli run --in doc.idml --cmd 'frame.create={"rect":[0,0,100,100]}' --page 1 --export out.pdf
designcraft-cli run --in doc --all-pages DIR        # every page as PNG
designcraft-cli script steps.jsonl --in doc --save out --export out.pdf [--keep-going]
designcraft-cli app [--port PORT] COMMAND [JSON]    # drive the running app
designcraft-cli links                               # community / web / source links
```

- `--page`, `--scale` and `--pdf-options JSON` apply to the exports that follow them.

## MCP

`designcraft-cli mcp [--sample]` (headless) or `--connect PORT` to the running app.
GUI: `designcraft [file]` (needs a display).
