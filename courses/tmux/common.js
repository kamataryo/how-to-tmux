// コース共通の部品。どのレッスンも tmux のセッション lesson の中で動くので、モジュールをまたいで使える。
// 判定の部品は、どれも 1 行のシェルコマンドを返す。

export const display = (format, value) => `[ "$(tmux display -p '${format}')" = '${value}' ]`;
export const panes = (n) => `[ $(tmux list-panes | wc -l) -eq ${n} ]`;
export const windows = (n) => `[ $(tmux list-windows | wc -l) -eq ${n} ]`;
export const clientSession = (name) => `[ "$(tmux list-clients -F '#S')" = '${name}' ]`;
export const clientAttached = '[ -n "$(tmux list-clients)" ]';

// 状態が変わらないコマンド（ls など）は、画面の内容で判定する
export const onScreen = (pattern) => `tmux capture-pane -p | grep -Eq '${pattern}'`;

// 今のウィンドウのペインでコマンドが動いている。ps で探すと、閉じたウィンドウの終了前のプロセスに反応してしまう
export const running = (command) => `tmux list-panes -F '#{pane_current_command}' | grep -qx '${command}'`;

export const STATUS_BAR = [0, 29, 100, 1];

// 端末がセッション lesson の 0 番のウィンドウを表示し、ペインが 1 つだけの状態にする。
// デタッチ中や tmux の終了後は元に戻せないので最後の確認で失敗し、VM が作り直される
export const RESET = [
  'tmux switch-client -t lesson',
  'tmux kill-session -a -t lesson',
  `w=$(tmux new-window -dP -F '#{window_id}' -t lesson:)`,
  'tmux kill-window -a -t "$w"',
  'tmux move-window -r -t lesson',
  'tmux refresh-client', // move-window は通知を出さないので、ページの layout を更新させる
  clientSession('lesson'),
].join('; ');

// デタッチ中は成功し、tmux が終了していると失敗する
export const ALIVE = 'tmux has-session -t lesson';
