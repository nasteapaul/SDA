---
name: filmcraft
description: Edit video with FilmCraft (open-source Premiere Pro clone, ArtCraft) through filmcraft-cli or its MCP server — projects, sequences, timeline edits, effects, exports to H.264/HEVC/ProRes/DNxHR/PNG/WAV, media probing. Use when the user wants Premiere-style video editing or mentions FilmCraft.
---

# FilmCraft (Premiere Pro) — `filmcraft-cli`

Missing? `bash .claude/skills/crafting-apps/install.sh filmcraft`. Tested: 0.6.0, 693 commands.
Own codecs (no FFmpeg). Project files: `.fcproj`. Exit status: 0 ok · 1 command failed · 2 usage.

```sh
filmcraft-cli help
filmcraft-cli commands [filter] [--json]          # id, label, shortcut, params
filmcraft-cli describe <id>                       # one command: menu, params, enabled now
filmcraft-cli probe clip.mp4                      # media info JSON
filmcraft-cli --project p.fcproj inspect [project|sequence]
filmcraft-cli --project p.fcproj --save import a.mp4 b.wav
filmcraft-cli --project p.fcproj --save exec timeline.razor seconds=3.5
filmcraft-cli --project p.fcproj --save run edits.jsonl        # one {"id","params"} per line, --keep-going
filmcraft-cli --project p.fcproj export out.mp4 [--preset name | --format h264] [--range inOut] [--scale 0.5]
filmcraft-cli export --list-presets [query]
filmcraft-cli --demo render --seconds 1 --out frame.png --scale 0.25   # one Program frame
```

- Options go before the subcommand: `--project`, `--demo`, `--save`, `--save-as`, `--bridge`, `--compact`.
- `key=value` values parse as JSON when possible. Time: 254016000000 ticks/s; most commands also take
  `seconds=`, `frame=` or `timecode=`.
- Useful ids: `timeline.place`, `timeline.select`, `timeline.razor`, `sequence.open`, `file.newBin`, `file.exportOtio`.

## MCP

`filmcraft-cli mcp` (headless; add `--project p.fcproj`), or live: `filmcraft --control PORT`, then
`filmcraft-cli mcp --bridge 127.0.0.1:PORT`. Agent work loop is in the repo's `docs/agents.md`.
GUI: `filmcraft [project]` (needs a display).
