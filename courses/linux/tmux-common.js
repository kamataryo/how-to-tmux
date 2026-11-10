// tmux の中で動くレッスンに共通の部品。どのレッスンも tmux のセッション SESSION の中で動くので、モジュールをまたいで使える。
// tmux を使わないコースでは使えない。判定の部品は、どれも 1 行のシェルコマンドを返す。

import { COLS, ROWS } from '../../vm-config.js';

// 端末が最初に表示しているセッション。VM のビルドでもこの名前で作る（index.js の vm）
export const SESSION = 'lesson';

export const display = (format, value) => `[ "$(tmux display -p '${format}')" = '${value}' ]`;
export const panes = (n) => `[ $(tmux list-panes | wc -l) -eq ${n} ]`;
export const windows = (n) => `[ $(tmux list-windows | wc -l) -eq ${n} ]`;
export const clientSession = (name) => `[ "$(tmux list-clients -F '#S')" = '${name}' ]`;
export const clientAttached = '[ -n "$(tmux list-clients)" ]';

// 状態が変わらないコマンド（ls など）は、画面の内容で判定する
export const onScreen = (pattern) => `tmux capture-pane -p | grep -Eq '${pattern}'`;

// 今のウィンドウのペインでコマンドが動いている。ps で探すと、閉じたウィンドウの終了前のプロセスに反応してしまう
export const running = (command) => `tmux list-panes -F '#{pane_current_command}' | grep -qx '${command}'`;

export const STATUS_BAR = [0, ROWS - 1, COLS, 1];

// 端末がセッション SESSION の 0 番のウィンドウを表示し、ペインが 1 つだけの状態にする。
// デタッチ中や tmux の終了後は元に戻せないので最後の確認で失敗し、VM が作り直される
export const RESET = [
  `tmux switch-client -t ${SESSION}`,
  `tmux kill-session -a -t ${SESSION}`,
  `w=$(tmux new-window -dP -F '#{window_id}' -t ${SESSION}:)`,
  'tmux kill-window -a -t "$w"',
  `tmux move-window -r -t ${SESSION}`,
  'tmux refresh-client', // move-window は通知を出さないので、ページの layout を更新させる
  clientSession(SESSION),
].join('; ');

// デタッチ中は成功し、tmux が終了していると失敗する
export const ALIVE = `tmux has-session -t ${SESSION}`;

// ライセンスを端末に表示する。top やコピーモードの最中に打つとキー操作になり、デタッチ中は見えないセッションへ届くので、
// シェルのプロンプトが見えているときだけ打つ。打ちかけの入力があると一緒に実行されるので、Ctrl-u で消す。
// 分割で狭くなったペインでは単語の途中で折り返されるので、fold で単語の切れ目で折る。
// fold | less とつなぐと先に終わる fold がプロセスグループの先頭になり、tmux が less の表示中も sh と報告するので、ファイルを介す。
// less は閉じるまで動き続け、その間の入力はシェルに届かないので、閉じ方をステータスバーに出す
export const SHOW_LICENSE = `${clientAttached} && ${display('#{pane_in_mode}:#{pane_current_command}', '0:sh')} && fold -s -w "$(tmux display -p '#{pane_width}')" /LICENSE >/tmp/LICENSE && tmux send-keys C-u 'less /tmp/LICENSE' Enter && tmux display-message -d 5000 'q で閉じます'`;
