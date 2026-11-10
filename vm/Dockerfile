# どのコースの VM にも共通の部分。v86 の tools/docker/alpine/Dockerfile をもとに、nodejs を外してシリアル端末を整えたもの。
# コースごとの中身は courses/<コース>/vm/Dockerfile がこのイメージに加える
FROM docker.io/i386/alpine:3.21.0

ENV KERNEL=virt

RUN apk add openrc alpine-base agetty alpine-conf linux-$KERNEL linux-firmware-none

# 画面は xterm.js だけなので、VGA 側の getty は要らない
RUN sed -i '/^tty[0-9]/d' /etc/inittab
RUN echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 xterm-256color' >> /etc/inittab
RUN echo "root:" | chpasswd

# ページからの依頼でコマンドを実行する窓口（vm-terminal.js の run()）。
# /dev/ttyS1 から「番号 コマンド」の行を受け取り、順に実行して「run 番号 終了コード」を返す。
# init の環境は HOME=/ なので、ペインと揃える。応答の形式を変えたら vm-terminal.js の RUN_RESULT も直すこと
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

# シリアルは端末サイズを伝えないので固定する。値は vm-config.js にあり、vm/build.sh が渡す。
# tmux の各ペインなどもログインシェルで起動するので、その大きさを壊さないようシリアルのときだけ実行する。
# /etc/hostname は docker export で上書きされるので、ホスト名もここで設定する
ARG COLS ROWS
RUN [ -n "$COLS" ] && [ -n "$ROWS" ] && echo "stty rows $ROWS cols $COLS" >/etc/serial-size
COPY <<'EOF' /root/.profile
if [ "$(tty)" = /dev/ttyS0 ]; then
  hostname localhost
  . /etc/serial-size
fi
export LANG=C.UTF-8
EOF

# https://wiki.alpinelinux.org/wiki/Alpine_Linux_in_a_chroot#Preparing_init_services
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add $i boot; done
RUN rc-update add killprocs shutdown

# Generate initramfs with 9p modules
RUN mkinitfs -F "base virtio 9p" $(cat /usr/share/kernel/$KERNEL/kernel.release)
