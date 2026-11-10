# Linux コースの VM。共通部分（vm/Dockerfile）に tmux を加える。vm/build.sh が BASE を渡してビルドする
ARG BASE
FROM $BASE

RUN apk add tmux

# 復元後の時計は保存時刻のままなので時刻は出さない。
# フックは /dev/ttyS1 経由でページへ操作を知らせる（tmux-hook / tmux-layout イベントになる）。
# 配置の通知は 1 行で送り、-b を付けないことで複数の通知が混ざらず、順番も保たれるようにする。
# 行の形式を変えたら tmux-terminal.js の LAYOUT_LINE も直すこと。
# VM はキーをまとめて受け取ることがあり、貼り付けと誤判定されると Ctrl-b が効かないので、その判定を切る
COPY <<'EOF' /root/.tmux.conf
set -g status-right ''
set -g assume-paste-time 0
set-hook -g after-split-window 'run-shell -b "echo split-window >/dev/ttyS1"'
set-hook -g after-new-window 'run-shell -b "echo new-window >/dev/ttyS1"'
%hidden NOTIFY_LAYOUT='run-shell "echo layout #{window_index} #{window_zoomed_flag} #{P:#{pane_id}:#{pane_left}:#{pane_top}:#{pane_width}:#{pane_height}:#{pane_active} }>/dev/ttyS1"'
set-hook -g window-layout-changed "$NOTIFY_LAYOUT"
set-hook -g window-pane-changed "$NOTIFY_LAYOUT"
set-hook -g session-window-changed "$NOTIFY_LAYOUT"
set-hook -g client-attached "$NOTIFY_LAYOUT"
set-hook -g after-refresh-client "$NOTIFY_LAYOUT"
EOF
