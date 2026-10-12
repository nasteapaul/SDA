---
name: pdfcraft
description: Work with PDFs using PdfCraft (also called PrintCraft; open-source Acrobat clone, ArtCraft) through pdfcraft-cli or its MCP server — info, text extraction, render pages to images, rotate/delete/move/insert pages, combine, extract, split, metadata, encrypted PDFs. Use when the user wants Acrobat-style PDF work or mentions PdfCraft/PrintCraft.
---

# PdfCraft / PrintCraft (Acrobat) — `pdfcraft-cli`

Missing? `bash .claude/skills/crafting-apps/install.sh pdfcraft`. Tested: 0.6.0.

```sh
pdfcraft-cli help
pdfcraft-cli info doc.pdf [--password PW]          # summary JSON
pdfcraft-cli text doc.pdf [--page N]                # pages separated by form feeds
pdfcraft-cli render doc.pdf --page 1 --dpi 96 --out p1.png
pdfcraft-cli edit in.pdf --out out.pdf --rotate 1,3:90 --delete 2 --move 5:1 --insert-blank 1 --title T --author A
pdfcraft-cli combine a.pdf b.pdf --out all.pdf
pdfcraft-cli extract in.pdf --pages 1,3,5 --out part.pdf
pdfcraft-cli split in.pdf --every 2 | --before 3,7 [--out-dir DIR]
pdfcraft-cli tools                                  # automation tools + JSON Schemas
pdfcraft-cli run <tool> key=value … --root DIR      # e.g. run doc_open path=…
pdfcraft-cli run --script steps.json --root DIR     # [{"tool":"doc_open","args":{…}}, …]
```

## MCP

`pdfcraft-cli mcp --root DIR [--compact]` (opt-in; file access confined to `--root`). Live app:
`pdfcraft --control FILE`, then `pdfcraft-cli ui --control FILE <method> …` (`inspect`, `click`, `screenshot`).
Never start MCP or the control channel by default. GUI: `pdfcraft [file.pdf]` (needs a display).
