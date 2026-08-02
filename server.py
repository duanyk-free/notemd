#!/usr/bin/env python3
"""Notemd — Lightweight Notepad++ style editor with Markdown preview.

Zero external dependencies. Uses only Python stdlib.
Start: python3 server.py [port]
Default port: 8099
"""

import json
import mimetypes
import os
import sys
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = 8099
APP_DIR = Path(__file__).parent / "app"
MAX_FILE_SIZE = 2 * 1024 * 1024  # 2 MB


class Handler(BaseHTTPRequestHandler):
    """Serves static files from app/ and provides a file API."""

    # ── routing ──────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._handle_api_get(parsed)
            else:
                self._serve_static(parsed.path)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._handle_api_post(parsed)
            else:
                self.send_error(404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_OPTIONS(self):
        self._send_cors()
        self.send_response(204)
        self.end_headers()

    # ── Static file serving ──────────────────────────────────────────────

    def _serve_static(self, path):
        # Default to index.html
        if path == "/":
            path = "/index.html"

        # Resolve file path relative to APP_DIR
        file_path = (APP_DIR / path.lstrip("/")).resolve()

        # Security: ensure it's within APP_DIR
        try:
            file_path.relative_to(APP_DIR.resolve())
        except ValueError:
            self.send_error(403, "Forbidden")
            return

        if not file_path.exists() or not file_path.is_file():
            self.send_error(404, "Not found")
            return

        # Determine content type
        content_type, _ = mimetypes.guess_type(str(file_path))
        if content_type is None:
            content_type = "application/octet-stream"

        try:
            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            self.send_error(500, "Read error")

    # ── API GET ──────────────────────────────────────────────────────────

    def _handle_api_get(self, parsed):
        params = dict(urllib.parse.parse_qsl(parsed.query))
        route = parsed.path

        if route == "/api/files":
            self._api_list(params.get("dir", str(Path.home())))
        elif route == "/api/read":
            self._api_read(params.get("file", ""))
        elif route == "/api/home":
            self._api_home()
        elif route == "/api/md2html":
            self._api_md2html(params.get("file", ""))
        else:
            self.send_error(404)

    # ── API POST ─────────────────────────────────────────────────────────

    def _handle_api_post(self, parsed):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        if parsed.path == "/api/write":
            self._api_write(body)
        elif parsed.path == "/api/save-as":
            self._api_write(body, is_new=True)
        elif parsed.path == "/api/render":
            self._api_render(body)
        else:
            self.send_error(404)

    # ── API implementations ──────────────────────────────────────────────

    def _api_home(self):
        self._json({"home": str(Path.home())})

    def _api_list(self, dir_path):
        p, err = self._safe_path(dir_path)
        if err:
            return self._json({"error": err}, 403)
        if not p.exists():
            return self._json({"error": "Directory not found"}, 404)
        if not p.is_dir():
            return self._json({"error": "Not a directory"}, 400)

        items = []
        try:
            for entry in sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
                try:
                    name = entry.name
                    if name.startswith("."):
                        continue
                    is_dir = entry.is_dir()
                    st = entry.stat()
                    items.append({
                        "name": name,
                        "path": str(entry),
                        "isDir": is_dir,
                        "size": st.st_size,
                        "mtime": int(st.st_mtime),
                    })
                except OSError:
                    continue
        except PermissionError:
            return self._json({"error": "Permission denied"}, 403)

        self._json({"items": items, "path": str(p)})

    def _api_read(self, file_path):
        p, err = self._safe_path(file_path)
        if err:
            return self._json({"error": err}, 403)
        if not p.exists():
            return self._json({"error": "File not found"}, 404)
        if p.is_dir():
            return self._json({"error": "Is a directory"}, 400)
        if p.stat().st_size > MAX_FILE_SIZE:
            return self._json({"error": "File too large (>2 MB)"}, 413)

        try:
            content = p.read_text(encoding="utf-8")
            self._json({"content": content, "path": str(p), "size": len(content)})
        except UnicodeDecodeError:
            return self._json({"error": "Binary file — cannot display"}, 415)
        except PermissionError:
            return self._json({"error": "Permission denied"}, 403)

    def _api_write(self, body, is_new=False):
        file_path = body.get("path", "")
        content = body.get("content", "")

        if not file_path:
            return self._json({"error": "No path provided"}, 400)

        p, err = self._safe_path(file_path)
        if err:
            return self._json({"error": err}, 403)
        if p.is_dir():
            return self._json({"error": "Is a directory — cannot overwrite"}, 400)
        if not is_new and not p.exists():
            return self._json({"error": "File not found"}, 404)

        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
            self._json({"ok": True, "path": str(p), "size": len(content)})
        except PermissionError:
            return self._json({"error": "Permission denied"}, 403)
        except OSError as e:
            return self._json({"error": str(e)}, 500)

    def _api_render(self, body):
        """Render markdown to HTML server-side using Python markdown + Pygments."""
        content = body.get("content", "")
        if not content:
            return self._json({"html": ""})

        try:
            import re
            import markdown as md_lib
            html = md_lib.markdown(
                content,
                extensions=[
                    "fenced_code",
                    "tables",
                    "codehilite",
                    "nl2br",
                    "sane_lists",
                ],
            )
            # Convert GFM task lists to checkboxes
            html = re.sub(r'<li>\[ \] ', '<li><input type="checkbox" disabled=""> ', html)
            html = re.sub(r'<li>\[x\] ', '<li><input type="checkbox" disabled="" checked=""> ', html)
            html = re.sub(r'<li>\[X\] ', '<li><input type="checkbox" disabled="" checked=""> ', html)
            self._json({"html": html})
        except ImportError:
            self._json({"error": "Python markdown library not available"}, 501)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _safe_path(path_str):
        """Resolve and validate a path — reject traversal outside home."""
        p = Path(path_str).expanduser().resolve()
        home = Path.home()
        try:
            p.relative_to(home)
        except ValueError:
            return None, "Access denied — path outside home directory"
        return p, None

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, fmt, *args):
        msg = fmt % args if args else fmt
        tag = "api" if "/api/" in msg else " →"
        sys.stderr.write(f"  [{tag}] {msg}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    server = HTTPServer(("0.0.0.0", port), Handler)
    print(f"  Notemd  v0.1.0")
    print(f"  → http://localhost:{port}")
    print(f"  Working dir: {Path.home()}")
    print(f"  Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Bye!")
        server.shutdown()


if __name__ == "__main__":
    main()
