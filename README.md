# Notemd

A lightweight Notepad++-style editor with live Markdown preview.

**Single 77KB file. Zero dependencies. Python stdlib only.**

## Quick Start

```bash
python3 notemd --browser
```

Then open http://localhost:8099

## Features

- 🗂 Tabbed editing (Ctrl+N/W, Ctrl+O to open)
- 📝 Markdown live preview (split pane, auto-show for .md files)
- 🎨 Syntax highlighting (Python, JS, HTML, CSS, Shell, C, SQL, YAML, Dockerfile...)
- 🌓 Dark / Light theme toggle
- 🔍 Search & Replace (Ctrl+F / Ctrl+H, F3 for next)
- 💾 Save / Save As (Ctrl+S)
- 📂 Visual file picker with directory navigation
- 📏 Line numbers, code folding, bracket matching

## Modes

| Mode | Command | Requires |
|------|---------|----------|
| Browser | `python3 notemd --browser` | Python 3.7+ |
| Desktop | `python3 notemd` | Python + pywebview |

## Project Structure

```
notemd          ← Standalone single-file executable (77KB)
server.py       ← Development mode (needs app/ directory)
app/            ← Frontend source (HTML/CSS/JS)
build-standalone.py  ← Build script
```

## Build

After modifying frontend files in `app/`:

```bash
python3 build-standalone.py
```

## License

MIT
