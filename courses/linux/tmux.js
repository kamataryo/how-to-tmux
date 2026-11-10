// tmux モジュール。データ構造は index.js を参照。
//
// ブラウザと OS に奪われるキーを教えない。
// Ctrl-w はタブを閉じ、Ctrl-Space は macOS の入力切替と衝突し、Option は xterm.js の既定では Meta にならない。

import { SESSION, STATUS_BAR, clientAttached, clientSession, display, onScreen, panes, running, windows } from './tmux-common.js';

// ペインの数ではなく方向で判定する。逆方向に分割して合格すると、その後の移動のステップが成り立たない
const splitRight = display('#{pane_at_left}', 0);
const splitDown = display('#{pane_at_top}', 0);

const REENTER_COPY_MODE = 'コピーモードを抜けてしまったら、`Ctrl-b [` で入り直してください。';

export default {
  id: 'tmux',
  title: 'tmux',
  lessons: [
    {
      id: 'panes',
      title: 'ペインで画面を分ける',
      goal: 'prefix の押し方を覚え、ペインの分割、移動、ズーム、終了ができる',
      steps: [
        {
          id: 'status-bar',
          say: '下の帯がステータスバーです。左端の `[lesson]` がセッション名、その右の `0:sh*` が今いるウィンドウです。始める前に、日本語入力をオフにしてください。',
          highlight: STATUS_BAR,
        },
        {
          id: 'split-right',
          say: 'tmux のショートカットは 2 段階です。`Ctrl-b`（prefix）を押して指を離し、続けて `%` を押すと、画面が左右に分かれます。',
          do: ['C-b', '%'],
          check: splitRight,
          hint: '`Ctrl-b` と `%` は同時に押しません。`%` は Shift+5 です。',
        },
        {
          id: 'split-down',
          say: 'カーソルのあるペインが分割の対象です。`Ctrl-b` のあと `"` で、今度は上下に分けましょう。この先は、この押し方を `Ctrl-b "` のように続けて書きます。',
          do: ['C-b', '"'],
          check: splitDown,
          hint: '`"` は JIS 配列なら Shift+2、US 配列なら Shift+\' です。',
        },
        {
          id: 'move-left',
          say: '`Ctrl-b ←` で左のペインへ移動します。',
          do: ['C-b', 'Left'],
          check: display('#{pane_at_left}', 1),
          highlight: 'active-pane',
        },
        {
          id: 'move-right',
          say: '`Ctrl-b →` で右へ戻ります。',
          do: ['C-b', 'Right'],
          check: display('#{pane_at_right}', 1),
          highlight: 'active-pane',
        },
        {
          id: 'independent',
          say: 'ペインごとに別のシェルが動いています。ここで `echo hello` を実行してください。ほかのペインは変わりません。',
          do: ['echo hello', 'Enter'],
          check: onScreen('^hello$'),
        },
        {
          id: 'zoom-in',
          say: '`Ctrl-b z` で、このペインだけを全画面にします。',
          do: ['C-b', 'z'],
          check: display('#{window_zoomed_flag}', 1),
        },
        {
          id: 'zoom-out',
          say: 'もう一度 `Ctrl-b z` で元に戻します。',
          do: ['C-b', 'z'],
          check: display('#{window_zoomed_flag}', 0),
        },
        {
          id: 'close-with-key',
          say: '`Ctrl-b x` を押すと確認が出るので、`y` で閉じます。',
          do: ['C-b', 'x', 'y'],
          check: panes(2),
          hint: 'ペインが 2 つになると次へ進みます。余分に分割していたら、もう一度閉じてください。',
        },
        {
          id: 'close-with-exit',
          say: 'シェルを終えてもペインは閉じます。`exit` を実行してください。',
          do: ['exit', 'Enter'],
          check: panes(1),
          hint: 'ペインが 1 つになると次へ進みます。ペインが 1 つだけのときに `exit` すると tmux ごと終わるので、そのときは「このレッスンをやり直す」を押してください。',
        },
      ],
    },
    {
      id: 'windows',
      title: 'ウィンドウを切り替える',
      goal: 'ウィンドウの作成、命名、切り替え、終了ができる',
      steps: [
        {
          id: 'new-window',
          say: 'ウィンドウはブラウザのタブのようなものです。`Ctrl-b c` で新しく作ります。ステータスバーに増えたのを確かめましょう。',
          do: ['C-b', 'c'],
          check: windows(2),
          highlight: STATUS_BAR,
        },
        {
          id: 'rename',
          say: '`Ctrl-b ,` で名前を変えられます。`logs` にしてください。',
          do: ['C-b', ',', 'C-u', 'logs', 'Enter'],
          check: display('#W', 'logs'),
          hint: '今の名前が入っているので、`Ctrl-u` で消してから打ち、`Enter` で確定します。',
        },
        {
          id: 'previous',
          say: '`Ctrl-b p` で前のウィンドウへ移ります。',
          do: ['C-b', 'p'],
          check: display('#I', 0),
        },
        {
          id: 'next',
          say: '`Ctrl-b n` で次のウィンドウへ移ります。',
          do: ['C-b', 'n'],
          check: display('#I', 1),
        },
        {
          id: 'by-number',
          say: '番号でも移れます。`Ctrl-b 0` で 0 番のウィンドウへ移ります。',
          do: ['C-b', '0'],
          check: display('#I', 0),
        },
        {
          id: 'open-list',
          say: '`Ctrl-b w` でウィンドウの一覧を開きます。',
          do: ['C-b', 'w'],
          check: display('#{pane_mode}', 'tree-mode'),
        },
        {
          id: 'pick-from-list',
          say: '`↓` で `logs` を選び、`Enter` で移ります。',
          do: ['Down', 'Enter'],
          check: display('#{pane_in_mode}:#W', '0:logs'),
        },
        {
          id: 'close-window',
          say: '`Ctrl-b &` を押すと確認が出るので、`y` でウィンドウごと閉じます。',
          do: ['C-b', '&', 'y'],
          check: windows(1),
          hint: 'ウィンドウが 1 つになると次へ進みます。余分に作っていたら、もう一度閉じてください。',
        },
      ],
    },
    {
      id: 'sessions',
      title: 'デタッチしても仕事は続く',
      goal: 'デタッチとアタッチ、セッションの切り替えができる',
      steps: [
        {
          id: 'run-top',
          say: '`top` を実行してください。リモートで動かす長い処理の代わりです。',
          do: ['top', 'Enter'],
          check: running('top'),
        },
        {
          id: 'detach',
          say: '`Ctrl-b d` で tmux から離れます（デタッチ）。SSH が切れたときも同じ状態になります。',
          do: ['C-b', 'd'],
          check: `! ${clientAttached}`,
        },
        {
          id: 'list-sessions',
          say: '`tmux ls` を実行してください。離れたあとも、セッションは動き続けています。確かめたら「次へ」を押します。',
          do: ['tmux ls', 'Enter'],
        },
        {
          id: 'attach',
          say: '`tmux attach` で戻りましょう。`top` は止まらずに動いています。',
          do: ['tmux attach', 'Enter'],
          check: clientAttached,
        },
        {
          id: 'quit-top',
          say: '`q` で `top` を終えます。',
          do: ['q'],
          check: `! ${running('top')}`,
        },
        {
          id: 'new-session',
          say: '`tmux new -d -s work` で、裏にもう 1 つセッションを作ります。',
          do: ['tmux new -d -s work', 'Enter'],
          check: 'tmux has-session -t work',
        },
        {
          id: 'choose-session',
          say: '`Ctrl-b s` で一覧を開き、`↓` で `work` を選んで `Enter` で移ります。ステータスバーの左端が変わります。',
          do: ['C-b', 's', 'Down', 'Enter'],
          check: clientSession('work'),
          highlight: STATUS_BAR,
        },
        {
          id: 'switch-back',
          say: '`Ctrl-b (` で元のセッションへ戻ります。',
          do: ['C-b', '('],
          check: clientSession(SESSION),
          highlight: STATUS_BAR,
        },
        {
          id: 'kill-session',
          say: '`tmux kill-session -t work` で `work` を片付けます。',
          do: ['tmux kill-session -t work', 'Enter'],
          check: '! tmux has-session -t work',
        },
      ],
    },
    {
      id: 'copy-mode',
      title: 'スクロールとコピー',
      goal: '過去の出力を遡り、検索してコピーできる',
      setup: 'tmux setw -g mode-keys vi; while tmux delete-buffer 2>/dev/null; do :; done',
      steps: [
        {
          id: 'vi-keys',
          say: 'このレッスンでは、コピーモードのキーを vi 流に設定してあります。',
          hint: '既定は emacs 流で、コピーは `Ctrl-w` ですが、ブラウザではタブが閉じてしまいます。自分の環境で同じ操作にするには、`~/.tmux.conf` に `setw -g mode-keys vi` と書きます。',
        },
        {
          id: 'output',
          say: '`seq 1 200` を実行してください。',
          do: ['seq 1 200', 'Enter'],
          check: onScreen('^200$'),
        },
        {
          id: 'enter-copy-mode',
          say: '先頭は画面の外へ流れました。`Ctrl-b [` でコピーモードに入ります。',
          do: ['C-b', '['],
          check: display('#{pane_mode}', 'copy-mode'),
        },
        {
          id: 'scroll',
          say: '`PageUp` で遡ります。',
          do: ['PageUp'],
          check: `[ "$(tmux display -p '#{scroll_position}')" -gt 0 ]`,
          hint: `Mac のキーボードでは \`fn\` と \`↑\` です。${REENTER_COPY_MODE}`,
        },
        {
          id: 'search',
          say: '`?` のあと `100` を打って `Enter` を押すと、上向きに検索します。',
          do: ['?', '100', 'Enter'],
          check: display('#{search_present}', 1),
          hint: REENTER_COPY_MODE,
        },
        {
          id: 'select',
          say: '`Space` で選択を始め、`l` を 2 回押して `100` を選びます。',
          do: ['Space', 'l', 'l'],
          check: display('#{selection_present}:#{copy_cursor_x}:#{==:#{selection_start_y},#{selection_end_y}}', '1:2:1'),
          hint: `選び直すには \`Escape\` で選択を解除し、カーソルを \`100\` の先頭へ戻して \`Space\` からやり直します。${REENTER_COPY_MODE}`,
        },
        {
          id: 'copy',
          say: '`Enter` でコピーします。コピーモードも終わります。',
          do: ['Enter'],
          check: `tmux show-buffer >/dev/null && ${display('#{pane_in_mode}', 0)}`,
          hint: `${REENTER_COPY_MODE}\`100\` を選び直してから \`Enter\` を押します。`,
        },
        {
          id: 'paste',
          say: '`echo pasted-` と打ち、実行せずに `Ctrl-b ]` で貼り付けて、`Enter` を押します。',
          do: ['echo pasted-', 'C-b', ']', 'Enter'],
          check: onScreen('^pasted-.'),
        },
      ],
    },
    {
      id: 'config',
      title: 'コマンドプロンプトと設定',
      goal: 'tmux のコマンドを直接実行し、設定ファイルを読み込める',
      setup: `tmux set -g mouse off; grep -v 'mouse on' ~/.tmux.conf >~/.tmux.conf.new; mv ~/.tmux.conf.new ~/.tmux.conf`,
      steps: [
        {
          id: 'split',
          say: '`Ctrl-b %` で左右に分けます。',
          do: ['C-b', '%'],
          check: splitRight,
        },
        {
          id: 'sync-on',
          say: 'ショートカットの実体は tmux のコマンドです。`Ctrl-b :` でコマンドを直接打てます。`setw synchronize-panes on` を実行してください。',
          do: ['C-b', ':', 'setw synchronize-panes on', 'Enter'],
          check: display('#{pane_synchronized}', 1),
        },
        {
          id: 'type-everywhere',
          say: 'これで全ペインに同じ入力が届きます。`echo all` を実行してください。複数のサーバーで同じ作業をするときに使います。',
          do: ['echo all', 'Enter'],
          check: `for p in $(tmux list-panes -F '#D'); do tmux capture-pane -p -t "$p" | grep -q '^all$' || exit 1; done`,
        },
        {
          id: 'sync-off',
          say: '同じようにして `setw synchronize-panes off` を実行し、元に戻します。',
          do: ['C-b', ':', 'setw synchronize-panes off', 'Enter'],
          check: display('#{pane_synchronized}', 0),
        },
        {
          id: 'write-config',
          say: '常に使う設定は `~/.tmux.conf` に書きます。`echo \'set -g mouse on\' >> ~/.tmux.conf` を実行してください。',
          do: [`echo 'set -g mouse on' >> ~/.tmux.conf`, 'Enter'],
          check: `grep -q 'mouse on' ~/.tmux.conf`,
        },
        {
          id: 'reload-config',
          say: '`Ctrl-b :` で `source-file ~/.tmux.conf` を実行すると、今のセッションに読み込まれます。',
          do: ['C-b', ':', 'source-file ~/.tmux.conf', 'Enter'],
          check: `[ "$(tmux show -gv mouse)" = on ]`,
        },
        {
          id: 'click',
          say: 'ペインをクリックすると、そのペインへ移れるようになりました。試したら「次へ」を押します。',
        },
      ],
    },
    {
      id: 'challenge',
      title: '総仕上げ',
      goal: '手順を見ずに作業環境を組み立てられる',
      steps: [
        {
          id: 'build-workspace',
          say: '`dev` という名前の新しいウィンドウを作り、左右に分割して右のペインで `top` を動かし、最後に左のペインをズームしてください。',
          do: ['C-b', 'c', 'C-b', ',', 'C-u', 'dev', 'Enter', 'C-b', '%', 'top', 'Enter', 'C-b', 'Left', 'C-b', 'z'],
          check: `${display('#W:#{window_zoomed_flag}:#{pane_at_left}', 'dev:1:1')} && ${panes(2)} && ${running('top')}`,
        },
      ],
    },
  ],
};
