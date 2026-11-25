"""Static server for local environments: index.html is never cached (so a new deploy shows on reload);
hashed assets/* are cached forever (their names change when their content does). Binds 127.0.0.1 only."""
import functools, http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.startswith('/assets/'):
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        else:
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

if __name__ == '__main__':
    port, directory = int(sys.argv[1]), sys.argv[2]
    http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=directory)).serve_forever()
