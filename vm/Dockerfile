# v86 の tools/docker/alpine/Dockerfile をもとに、nodejs を tmux へ替え、シリアル端末を tmux 向けに整えたもの
FROM docker.io/i386/alpine:3.21.0

ENV KERNEL=virt

RUN apk add openrc alpine-base agetty alpine-conf linux-$KERNEL linux-firmware-none tmux

# 画面は xterm.js だけなので、VGA 側の getty は要らない
RUN sed -i '/^tty[0-9]/d' /etc/inittab
RUN echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 xterm-256color' >> /etc/inittab
RUN echo "root:" | chpasswd

# ページからの依頼でコマンドを実行する窓口（tmux-terminal.js の run()）。
# /dev/ttyS1 から「番号 コマンド」の行を受け取り、順に実行して「run 番号 終了コード」を返す。
# init の環境は HOME=/ なので、ペインと揃える。応答の形式を変えたら tmux-terminal.js の RUN_RESULT も直すこと
RUN echo 'ttyS1::respawn:/usr/local/bin/lesson-agent' >> /etc/inittab
COPY --chmod=755 <<'EOF' /usr/local/bin/lesson-agent
#!/bin/sh
export HOME=/root LANG=C.UTF-8
cd
stty raw -echo
while read -r id cmd; do
  timeout 10 sh -c "$cmd" </dev/null >/dev/null 2>&1
  echo "run $id $?"
done
EOF

# シリアルは端末サイズを伝えないので固定する。tmux-terminal.js の xterm.js と同じ値にすること。
# tmux の各ペインもログインシェルで起動するので、ペインの大きさを壊さないようシリアルのときだけ実行する。
# /etc/hostname は docker export で上書きされるので、ホスト名もここで設定する
COPY <<'EOF' /root/.profile
if [ "$(tty)" = /dev/ttyS0 ]; then
  hostname forcage
  stty rows 30 cols 100
fi
export LANG=C.UTF-8
EOF

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

# https://wiki.alpinelinux.org/wiki/Alpine_Linux_in_a_chroot#Preparing_init_services
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add $i boot; done
RUN rc-update add killprocs shutdown

# Generate initramfs with 9p modules
RUN mkinitfs -F "base virtio 9p" $(cat /usr/share/kernel/$KERNEL/kernel.release)
