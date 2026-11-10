# How to tmux

##　開発

Docker、Node.js、zstd、Python 3 が必要です。

```sh
vm/build.sh  # dist/site に配信物を作る（2 分ほど）
python3 vm/serve.py
open http://127.0.0.1:8000/
npm test     # 配信物をヘッドレス Chrome で開き、全ステップを通す
```

## 構成

配信物は 1 つのコースと、そのコースの VM でできています。`vm/build.sh [コース]` がコースを選び（既定は `linux`）、ページとテストは配信物の `course.mjs` でどのコースかを知ります。

| 場所 | 内容 | tmux に依存するか |
|---|---|---|
| `vm-terminal.js` | `<vm-terminal>`。VM のシリアル端末の表示と `run()` | しない |
| `tmux-terminal.js` | `<tmux-terminal>`。`<vm-terminal>` に tmux の通知を加えたもの | する |
| `lesson-player.js` | シナリオを進める | しない（`highlight: 'active-pane'` だけは `<tmux-terminal>` が要る） |
| `vm-config.js` | 端末の桁数と行数、v86 の設定。ページとビルドの両方が読む | しない |
| `vm/` | どのコースにも共通の VM（`Dockerfile`）とビルド | しない |
| `courses/<コース>/` | シナリオと、そのコースの VM に入れるもの（`vm/Dockerfile`） | コースによる |

### コースを増やす

1. `courses/<コース>/vm/Dockerfile` を作ります。`ARG BASE` と `FROM $BASE` で始め、共通の VM に入れたいものを加えます。
2. `courses/<コース>/index.js` にシナリオを書きます。素のシェルで始めるなら `terminal` と `vm` は要りません。tmux の中で始めるなら `courses/linux/index.js` と同じ値を書きます。
3. `vm/build.sh <コース>` でビルドします。

## シナリオを書く

シナリオは `courses/<コース>/` にあり、形は `courses/linux/index.js` の先頭に書いてあります。`lesson-player.js` はシナリオの中身を知らず、`setup` と `check` を VM で実行して、終了コードだけを見て進めます。

新しいモジュールは `courses/linux/<名前>.js` に書き、`index.js` の `modules` に加えます。ステップのデータだけを書けば、次のものは共通の仕組みが受け持ちます。

| 共通の仕組み | 場所 |
|---|---|
| レッスン開始時の初期化と、できないときの VM の作り直し | `courses/linux/index.js` の `setup` |
| 環境が止まったときの表示 | `courses/linux/index.js` の `alive` |
| 判定の部品（`onScreen()`、`running()` など）。tmux の中で動くレッスン用 | `courses/linux/tmux-common.js` |
| 全ステップの自動テスト | `npm test`（`do` を打って通す） |

```js
{
  id: 'split-right',
  say: '`Ctrl-b` のあと `%` で左右に分けます。',  // 指示
  do: ['C-b', '%'],                               // 正解の操作
  check: '[ $(tmux list-panes | wc -l) -eq 2 ]',  // 合格の条件
}
```

- **新しい概念には図を付ける:** ステップに `figure: { name, alt }` を書くと、`courses/<コース>/figures/<name>.svg` を指示の下に表示します。図は 440×200 の `viewBox` で、欄の幅（約 430px）で読める文字の大きさに描きます。クリックすると大きく開きます。`<img>` で読むので、色とフォントは SVG の中に書きます。
- **状態が変わらないコマンドの判定:** `ls` などは `onScreen()` で画面の内容を見ます。
- **`do` を必ず書く:** `npm test` が `do` を打って全ステップを通します。`check` が `do` を打ち終える前に成功するステップは失敗にします。指示を読み終える前に進んでしまうためです。
- **最初から合格しているステップは自動では進まない:** 前の操作で先にその状態になっていると、読む前に次へ進んでしまうので、「次へ」を押してもらいます。
- **`check` は間違えた後でも正解できるように書く:** 操作の回数やペインの数ではなく、目的の状態を判定します。回数に頼ると、やり直しても合格できなくなります。
- **`setup` はやり直せるように書く:** 0 以外で終わると、ページを再読み込みして VM を作り直してからもう一度実行します。
- **ブラウザと OS に奪われるキーを教えない:** `Ctrl-w` はタブを閉じ、`Ctrl-Space` は macOS の入力切替と衝突し、Option は xterm.js の既定では Meta になりません。

## `<vm-terminal>` と `<tmux-terminal>` の使い方

```html
<script type="module" src="./tmux-terminal.js"></script>
<tmux-terminal></tmux-terminal>
```

要素を置くと VM を読み込み、読み込み中は進捗バーを表示します。端末は 100×30 桁の固定です（`vm-config.js`）。要素を外すと VM を破棄し、付け直すと最初の状態から始まります。

`<vm-terminal>` は VM の中で何が動いているかを知りません。`<tmux-terminal>` はそれを拡張し、tmux のフックからの通知を加えます。下の表で「tmux」とあるものは `<tmux-terminal>` だけにあります。

| 名前 | 種類 | 内容 |
|---|---|---|
| `highlight(col, row, width, height)` | メソッド | 画面に矩形を重ねて描き、その要素を返す |
| `ready` | プロパティ | `run()` を使えるか。VM が動き出して `lesson-agent` が応答すると `true` |
| `vm-ready` | イベント | `ready` が `true` になった |
| `send(data)` | メソッド | 利用者が打ったのと同じように、端末へ文字を送る |
| `vm-line` | イベント | VM が `/dev/ttyS1` に書いた行。`detail` はその行。`<tmux-terminal>` では出ず、下の 2 つのイベントになる |
| `layout` | プロパティ | tmux。最新のペインの配置。最初の通知までは `null` |
| `focus()` | メソッド | キー入力を端末へ向ける |
| `fit(width, height)` | メソッド | 文字盤が指定の大きさ（px）に収まるよう文字の大きさを変える。桁数と行数は変わらない。引数なしで元に戻す |
| `run(command)` | メソッド | VM でシェルコマンドを実行し、終了コードの Promise を返す |
| `tmux-layout` | イベント | tmux。ペインの配置が変わった。`detail` は `layout` と同じ形 |
| `tmux-hook` | イベント | tmux。tmux の操作の通知。`detail` は `split-window` か `new-window` |

### 画面の一部をハイライトする

座標は文字単位で、0 から数えます。桁は 0〜99、行は 0〜29 で、ステータスバーは行 29 です。

```js
const terminal = document.querySelector('tmux-terminal');

// ステータスバーの左端 8 桁を囲む
const box = terminal.highlight(0, 29, 8, 1);

// 返り値は普通の div なので、見た目も消し方も DOM のまま
box.style.borderColor = '#0cf';
box.remove();
```

- クリックとキー入力は下の端末へ通ります。
- tmux が画面を描き直しても消えません。その代わり、ペインが動いても追従しないので、必要なら次の `tmux-layout` で描き直します。
- 文字盤の外にはみ出した部分は描かれません。

### ペインの配置を受け取る

分割、ペインの移動と入れ替え、ズーム、ウィンドウの切り替え、ペインやウィンドウを閉じたとき、再接続したときに通知します。tmux の桁と行がそのまま `highlight()` の座標になります。

```js
{
  window: 0,      // 表示中のウィンドウ番号
  zoomed: false,  // ズーム中か
  panes: [        // 表示中のウィンドウのペイン
    { id: '%0', col: 0,  row: 0, width: 50, height: 29, active: false },
    { id: '%1', col: 51, row: 0, width: 49, height: 29, active: true },
  ],
}
```

次の例は、アクティブなペインを常に囲みます。起動時の通知を逃さないよう、先に `layout` も見ます。

```js
const terminal = document.querySelector('tmux-terminal');
let box;

const follow = (layout) => {
  box?.remove();
  const pane = layout.panes.find((p) => p.active);
  box = pane && terminal.highlight(pane.col, pane.row, pane.width, pane.height);
};

if (terminal.layout) follow(terminal.layout);
terminal.addEventListener('tmux-layout', (event) => follow(event.detail));
```

- 1 回の操作で複数回通知することがあります。最後の通知が最新の配置です。
- `zoomed` が `true` のあいだ、正しい位置にあるのはアクティブなペインだけです。ほかのペインの値はズーム前のものです。
- `move-window` と `swap-window` でウィンドウの番号が変わっても通知しません（tmux に対応するフックがありません）。その後に `tmux refresh-client` を実行すると通知します。

### キー入力を先に受け取る

端末に届く前のキーは、`window` の `keydown` を capture（第 3 引数の `true`）で受け取れます。

```js
addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'b') showHint('次のキーを待っています');
}, true);
```

`event.preventDefault()` と `event.stopPropagation()` を呼ぶと、そのキーは VM に届きません。

### VM でコマンドを実行する

レッスンの準備や合否の判定に使います。画面には何も出ません。

```js
// 2 分割されていれば 0
const code = await terminal.run('[ $(tmux list-panes | wc -l) -eq 2 ]');
```

- `ready` が `false` のあいだは VM の起動前なので、呼ぶと reject します。`vm-ready` を待ってから呼びます。
- root として `/root` で実行します。標準入力は空で、出力は捨てられます。
- コマンドは 1 行だけで、複数を同時に呼ぶと順番に実行します。
- 10 秒で打ち切り、終了コードは 143 になります。
- 応答が 15 秒ないときや要素を外したときは reject します。利用者が VM の中で `lesson-agent` を止めても init が再起動するので、その後の呼び出しから復帰します。

## レッスンを書くときの注意

- **スクリプトは別ファイルにする:** CSP によりインラインスクリプトは動きません。同一オリジンの `.js` ファイルにしてください。リポジトリの直下に置いた `.js` は `vm/build.sh` が配信物に加えます。
- **VM からの値を信頼しない:** 利用者は VM の root なので、`echo 'layout …' >/dev/ttyS1` などで通知を偽装できます。`detail` を `innerHTML` に入れず、合否の判定を権限や認定に使わないでください。形式の合わない `layout` の行は捨てられます。
- **VM の時計は保存時刻のまま:** ビルド時の状態を復元するので、VM の中の時刻は正しくありません。ステータスバーの時刻は消してあります。
