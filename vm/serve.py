# 開発用の配信。リポジトリの直下で python3 vm/serve.py と実行する。
# http.server の既定では Cache-Control が付かず、普通の再読み込みでは JS が古いキャッシュのまま読まれることがある。
# no-cache なら毎回更新を確かめ、変更がなければ 304 で済むので VM のイメージを転送し直さない
import functools
import http.server


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    handler = functools.partial(NoCache, directory='dist/site')
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 8000), handler)
    print('http://127.0.0.1:8000/')
    server.serve_forever()
