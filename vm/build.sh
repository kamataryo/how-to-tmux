#!/usr/bin/env bash
# 配信物を $OUT/site に作る。Docker と Node、zstd が必要。
# 使い方: vm/build.sh（既定の出力先は dist）/ OUT=/path/to/out vm/build.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
OUT=${OUT:-$ROOT/dist}
NAME=v86-tmux-forcage

# どれも公開から 1 か月以上たった版に固定する。コミットは v86 0.5.470 の公開直前のもの
V86_VERSION=0.5.470
V86_COMMIT=6db8b157974dbaf1b54d2c2ec12dd71ddc1891e9
XTERM_VERSION=6.0.0

WORK=$OUT/work
SITE=$OUT/site
RAW=https://raw.githubusercontent.com/copy/v86/$V86_COMMIT
rm -rf "$SITE" # 状態ファイルはイメージに依存するので一緒に作り直す
mkdir -p "$WORK/tools" "$SITE/v86" "$SITE/bios" "$SITE/xterm" "$SITE/images/rootfs-flat"

# npm の tarball は直接取得し、配信物だけを取り出す（依存の解決は不要）
curl -fsS -o "$WORK/v86.tgz" "https://registry.npmjs.org/v86/-/v86-$V86_VERSION.tgz"
tar xzf "$WORK/v86.tgz" -C "$SITE/v86" --strip-components=2 package/build/libv86.mjs package/build/v86.wasm
curl -fsS -o "$WORK/xterm.tgz" "https://registry.npmjs.org/@xterm/xterm/-/xterm-$XTERM_VERSION.tgz"
tar xzf "$WORK/xterm.tgz" -C "$SITE/xterm" --strip-components=2 package/lib/xterm.mjs package/css/xterm.css

for f in tools/fs2json.py tools/copy-to-sha256.py; do curl -fsS -o "$WORK/$f" "$RAW/$f"; done
for f in bios/seabios.bin bios/vgabios.bin; do curl -fsS -o "$SITE/$f" "$RAW/$f"; done

docker build "$HERE" --platform linux/386 --rm --tag "$NAME"
docker rm "$NAME" 2>/dev/null || true
docker create --platform linux/386 --name "$NAME" "$NAME"
docker export "$NAME" -o "$WORK/rootfs.tar"
docker rm "$NAME"

# .dockerenv が残ると OpenRC がコンテナと誤認する。macOS の tar は --delete がないのでコンテナ内で消す。
# zstd 変換には Python 3.14 が要るので、変換ツールもコンテナ内で動かす
docker run --rm -v "$WORK:/work" -v "$SITE/images:/images" python:3.14-alpine sh -euc '
  apk add --no-cache tar >/dev/null
  tar -f /work/rootfs.tar --delete .dockerenv || true
  python -I /work/tools/fs2json.py --zstd --out /work/fs.json /work/rootfs.tar
  python -I /work/tools/copy-to-sha256.py --zstd /work/rootfs.tar /images/rootfs-flat
' 2>&1 | tail -3

node "$HERE/make-state.mjs" "$SITE" "$WORK/fs.json"
cp "$ROOT/index.html" "$ROOT/tmux-terminal.js" "$ROOT/lesson-player.js" "$SITE/"
cp -R "$ROOT/courses" "$SITE/"
echo "完了: $SITE"
