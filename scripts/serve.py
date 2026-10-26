#!/usr/bin/env python3
"""
Preview server for PYQ Studio.

Serves the repository root as static files on 0.0.0.0 so the sandbox preview can
reach it. Unlike `python3 -m http.server`, it sends no-store cache headers for
app code and data, so a normal page reload always picks up the files on disk
instead of a stale cached module. The service worker is also served no-store so
a version bump is seen immediately.

    python3 scripts/serve.py [port]
"""

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NO_STORE_SUFFIXES = (".html", ".js", ".mjs", ".css", ".json", ".webmanifest")


class PreviewHandler(SimpleHTTPRequestHandler):
    """Static handler with cache headers that suit an iterating preview."""

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.endswith(NO_STORE_SUFFIXES) or path == "/sw.js":
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
        else:
            self.send_header("Cache-Control", "no-cache")
        # KaTeX loads fonts from the same origin; a lenient policy keeps the
        # preview free of console noise from the default strict handler.
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        # Single-page routes are hash based, so any missing path that is not a
        # file request falls back to the shell instead of a 404 page.
        target = self.translate_path(self.path)
        wants_file = os.path.splitext(self.path.split("?", 1)[0])[1]
        if not os.path.exists(target) and not wants_file:
            self.path = "/index.html"
        super().do_GET()

    def log_message(self, fmt, *args):
        # Keep the log to the request line; the tracker only needs status codes.
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    handler = partial(PreviewHandler, directory=ROOT)
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"PYQ Studio preview on http://0.0.0.0:{port} (root: {ROOT})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
