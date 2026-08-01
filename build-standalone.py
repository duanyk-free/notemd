#!/usr/bin/env python3
"""Build a single-file standalone Notemd.

Generates: notemd (single executable Python script, ~70KB)
  - Embeds all HTML/CSS/JS as string constants
  - Zero external dependencies (stdlib only)
  - Optional: pywebview for native desktop window

Usage:
  python3 build-standalone.py           # generate notemd
  python3 build-standalone.py --run     # generate + immediately launch
"""

import sys
from pathlib import Path

ROOT = Path(__file__).parent
APP_DIR = ROOT / "app"

FILES = {
    "index.html":         "text/html; charset=utf-8",
    "style.css":          "text/css; charset=utf-8",
    "app.js":             "application/javascript; charset=utf-8",
    "pygments-dark.css":  "text/css; charset=utf-8",
    "pygments-light.css": "text/css; charset=utf-8",
}


def embed(path):
    raw = path.read_text("utf-8")
    esc = raw.replace("\\", "\\\\").replace('"""', '\\"\\"\\"')
    return f'"""{esc}"""'


def build():
    # Read all assets
    assets = {}
    for fname in FILES:
        fpath = APP_DIR / fname
        if not fpath.exists():
            print(f"ERROR: {fpath} not found")
            sys.exit(1)
        assets[fname] = (FILES[fname], embed(fpath))
        print(f"  ✓ embedded {fname}  ({fpath.stat().st_size:,} bytes)")

    # Build embedded dict
    entries = []
    for fname, (ct, literal) in assets.items():
        entries.append(f'        "{fname}": ("{ct}", {literal}),')
    embedded_block = "\n".join(entries)

    # Read the desktop launcher template
    desktop_path = ROOT / "notemd-desktop.py"
    code = desktop_path.read_text("utf-8")

    # Replace the _EMBEDDED loading section
    old_load = '''def _load_embedded():
    """Load frontend files from app/ directory into memory."""
    global _EMBEDDED
    files = {
        "index.html":         "text/html; charset=utf-8",
        "style.css":          "text/css; charset=utf-8",
        "app.js":             "application/javascript; charset=utf-8",
        "pygments-dark.css":  "text/css; charset=utf-8",
        "pygments-light.css": "text/css; charset=utf-8",
    }
    for filename, ct in files.items():
        path = APP_DIR / filename
        if path.exists():
            _EMBEDDED[filename] = (ct, path.read_text(encoding="utf-8"))'''

    new_load = f'''def _load_embedded():
    """Load frontend files from embedded data (or fallback to disk)."""
    global _EMBEDDED
    # Built-in embedded assets (auto-generated)
    _EMBEDDED = {{
{embedded_block}
    }}
    # If app/ directory exists, prefer disk versions (for development)
    if APP_DIR.is_dir():
        for filename, ct in [
            ("index.html", "text/html; charset=utf-8"),
            ("style.css", "text/css; charset=utf-8"),
            ("app.js", "application/javascript; charset=utf-8"),
            ("pygments-dark.css", "text/css; charset=utf-8"),
            ("pygments-light.css", "text/css; charset=utf-8"),
        ]:
            path = APP_DIR / filename
            if path.exists():
                _EMBEDDED[filename] = (ct, path.read_text(encoding="utf-8"))'''

    if old_load in code:
        code = code.replace(old_load, new_load)
    else:
        print("ERROR: Could not find _load_embedded function to patch")
        sys.exit(1)

    # Write output
    out = ROOT / "notemd"
    out.write_text(code, "utf-8")
    out.chmod(0o755)
    print(f"\n  ✅ {out}  ({out.stat().st_size:,} bytes)")
    print(f"  Usage:")
    print(f"    ./notemd                  # desktop window (needs pywebview)")
    print(f"    ./notemd --browser        # open in browser")
    print(f"    ./notemd --port 9000      # custom port")
    return out


def main():
    print("Building standalone Notemd...\n")
    out = build()
    if "--run" in sys.argv:
        print("\n  Starting...\n")
        import subprocess
        subprocess.run([sys.executable, str(out), "--browser"])


if __name__ == "__main__":
    main()
