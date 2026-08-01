#!/usr/bin/env python3
"""Notemd Desktop — native window launcher.

Dependencies (optional):
  pywebview  → native desktop window (pip install pywebview)
  None       → falls back to opening browser tab

Usage:
  python3 notemd-desktop.py                # desktop window (auto-detect)
  python3 notemd-desktop.py --browser      # force browser mode
  python3 notemd-desktop.py --port 9000    # custom port
"""

import json
import mimetypes
import os
import sys
import threading
import urllib.parse
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = 8099
APP_DIR = Path(__file__).parent / "app"
MAX_FILE_SIZE = 2 * 1024 * 1024

# ── Embedded frontend assets ─────────────────────────────────────────────
# These are populated by build-standalone.py, or loaded from disk at startup.

_EMBEDDED = {}  # { "index.html": (content_type, data_string), ... }


def _load_embedded():
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
            _EMBEDDED[filename] = (ct, path.read_text(encoding="utf-8"))


# ── HTTP Handler (same API as server.py, but self-contained) ───────────

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._api_get(parsed)
            else:
                self._serve_embedded(parsed.path)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._api_post(parsed)
            else:
                self.send_error(404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_OPTIONS(self):
        self._cors()
        self.send_response(204)
        self.end_headers()

    # ── Static serving (from memory) ──────────────────────────────────

    def _serve_embedded(self, path):
        if path == "/":
            path = "/index.html"
        key = path.lstrip("/")
        if key not in _EMBEDDED:
            self.send_error(404)
            return
        ct, body = _EMBEDDED[key]
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ── API ───────────────────────────────────────────────────────────

    def _api_get(self, parsed):
        params = dict(urllib.parse.parse_qsl(parsed.query))
        if parsed.path == "/api/files":
            self._list(params.get("dir", str(Path.home())))
        elif parsed.path == "/api/read":
            self._read(params.get("file", ""))
        elif parsed.path == "/api/home":
            self._json({"home": str(Path.home())})
        else:
            self.send_error(404)

    def _api_post(self, parsed):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}
        if parsed.path == "/api/write":
            self._write(body)
        elif parsed.path == "/api/save-as":
            self._write(body, is_new=True)
        elif parsed.path == "/api/render":
            self._render(body)
        else:
            self.send_error(404)

    def _list(self, dir_path):
        p, err = self._safe(dir_path)
        if err: return self._json({"error": err}, 403)
        if not p.is_dir(): return self._json({"error": "Not a directory"}, 400)
        items = []
        try:
            for e in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                if e.name.startswith("."): continue
                st = e.stat()
                items.append({"name": e.name, "path": str(e), "isDir": e.is_dir(),
                              "size": st.st_size, "mtime": int(st.st_mtime)})
        except PermissionError:
            return self._json({"error": "Permission denied"}, 403)
        self._json({"items": items, "path": str(p)})

    def _read(self, path):
        p, err = self._safe(path)
        if err: return self._json({"error": err}, 403)
        if p.is_dir(): return self._json({"error": "Is a directory"}, 400)
        if p.stat().st_size > MAX_FILE_SIZE: return self._json({"error": "Too large"}, 413)
        try:
            self._json({"content": p.read_text("utf-8"), "path": str(p), "size": p.stat().st_size})
        except UnicodeDecodeError:
            return self._json({"error": "Binary file"}, 415)
        except PermissionError:
            return self._json({"error": "Permission denied"}, 403)

    def _write(self, body, is_new=False):
        p, err = self._safe(body.get("path", ""))
        if err: return self._json({"error": err}, 403)
        if p.is_dir(): return self._json({"error": "Is a directory"}, 400)
        if not is_new and not p.exists(): return self._json({"error": "Not found"}, 404)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body.get("content", ""), "utf-8")
            self._json({"ok": True, "path": str(p)})
        except PermissionError:
            return self._json({"error": "Permission denied"}, 403)
        except OSError as e:
            return self._json({"error": str(e)}, 500)

    def _render(self, body):
        content = body.get("content", "")
        if not content: return self._json({"html": ""})
        try:
            import markdown as md
            html = md.markdown(content, extensions=["fenced_code", "tables", "codehilite", "nl2br", "sane_lists"])
            self._json({"html": html})
        except ImportError:
            self._json({"error": "markdown library not available"}, 501)

    # ── Helpers ───────────────────────────────────────────────────────

    def _safe(self, path_str):
        p = Path(path_str).expanduser().resolve()
        try:
            p.relative_to(Path.home())
        except ValueError:
            return None, "Access denied"
        return p, None

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, fmt, *args):
        pass  # silent


# ── Server runner ────────────────────────────────────────────────────────

def _run_server():
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


# ── Entry points ─────────────────────────────────────────────────────────

def run_desktop():
    """Open in a native desktop window via pywebview."""
    try:
        import webview
    except ImportError:
        print("[!] pywebview not installed. Run: pip install pywebview")
        print("[!] Using browser fallback...")
        return run_browser()

    threading.Thread(target=_run_server, daemon=True).start()
    webview.create_window(
        title="Notemd — Markdown Editor",
        url=f"http://127.0.0.1:{PORT}",
        width=1280,
        height=800,
        min_size=(800, 500),
    )
    webview.start()


def run_browser():
    """Open in the default web browser."""
    threading.Thread(target=_run_server, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}"
    print(f"  → {url}")
    webbrowser.open(url)
    print("  Press Ctrl+C to stop.")
    try:
        import time
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("  Bye!")


# ── Main ─────────────────────────────────────────────────────────────────

def main():
    global PORT
    args = sys.argv[1:]

    if "--port" in args:
        PORT = int(args[args.index("--port") + 1])

    # Load frontend into memory
    _load_embedded()
    print(f"  Notemd Desktop  v0.2.0")
    print(f"  → http://127.0.0.1:{PORT}")

    if "--browser" in args:
        run_browser()
    else:
        try:
            run_desktop()
        except Exception:
            run_browser()


if __name__ == "__main__":
    main()
