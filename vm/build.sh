#!/usr/bin/env bash
# コースの配信物を $OUT/site に作る。Docker と Node、zstd が必要。
# 使い方: vm/build.sh [コース]（既定のコースは linux、出力先は dist）/ OUT=/path/to/out vm/build.sh linux
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
OUT=${OUT:-$ROOT/dist}
COURSE=${1:-linux}
[ -f "$ROOT/courses/$COURSE/vm/Dockerfile" ] || { echo "courses/$COURSE/vm/Dockerfile がありません" >&2; exit 1; }
BASE=v86-lesson-base
NAME=v86-lesson-$COURSE

# どれも公開から 1 か月以上たった版に固定する。コミットは v86 0.5.470 の公開直前のもの。
# V86_COMMIT を変えたら LICENSE.txt の SeaBIOS の版とリンクも直す
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

# 共通部分の上にコースの中身を重ねる。端末サイズは vm-config.js の値を渡す
SIZE=$(node -e 'import(process.argv[1]).then((c) => console.log(`--build-arg COLS=${c.COLS} --build-arg ROWS=${c.ROWS}`))' "$ROOT/vm-config.js")
docker build "$HERE" --platform linux/386 --rm $SIZE --tag "$BASE"
docker build "$ROOT/courses/$COURSE/vm" --platform linux/386 --rm --build-arg "BASE=$BASE" --tag "$NAME"
# LICENSE.txt のソース提供の申し出が対象とする版の一覧。apk add は版を固定していないので、ビルドごとに書き出す
docker run --rm --platform linux/386 "$NAME" apk list -I >"$SITE/packages.txt"
docker rm "$NAME" 2>/dev/null || true
docker create --platform linux/386 --name "$NAME" "$NAME"
docker cp "$ROOT/LICENSE.txt" "$NAME:/LICENSE" # ライセンスのリンクで less に開く。ビルドのコンテキストは vm/ なので Dockerfile からは読めない
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

# 編集がそのまま反映されるようリンクにする。公開するときは cp -RL で実体にする
ln -s "$ROOT/index.html" "$ROOT"/*.js "$ROOT/courses" "$ROOT/LICENSE.txt" "$SITE/"
# ページとテストは、このファイルでどのコースの配信物かを知る
echo "export { default } from './courses/$COURSE/index.js';" >"$SITE/course.mjs"
node "$HERE/make-state.mjs" "$SITE" "$WORK/fs.json"
"$HERE/render-images.sh" "$SITE"
echo "完了: $SITE"
