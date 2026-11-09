#!/usr/bin/env bash
# brand/*.html を Chrome で PNG にする。ブラウザは環境変数 CHROME で変更できる
# 使い方: vm/render-images.sh <出力先>（vm/build.sh からも呼ぶ。HTML を直しただけなら dist/site を指定してこれだけ実行する）
set -euo pipefail

ROOT=$(dirname "$(cd "$(dirname "$0")" && pwd)")
OUT=$1
CHROME=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/how-to-tmux-render.XXXXXX")
trap 'rm -rf "$PROFILE"' EXIT

render() { # 名前 幅 高さ
  "$CHROME" --headless=new --user-data-dir="$PROFILE" --no-first-run --disable-extensions \
    --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size="$2,$3" --screenshot="$OUT/$1.png" "file://$ROOT/brand/$1.html" 2>/dev/null
}

render ogp 1200 630
render icon 512 512
