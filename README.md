# How to tmux

ブラウザで動く Linux の講座で、今は tmux のショートカットを学ぶモジュールがあります。ブラウザ内の Linux VM（[v86](https://github.com/copy/v86)）で本物の tmux 3.5a を動かし、[xterm.js](https://github.com/xtermjs/xterm.js) で表示します。サーバー側の処理はなく、静的ファイルの配信だけで動きます。

## 動かす

Docker、Node.js、zstd、Python 3 が必要です。

```sh
vm/build.sh  # dist/site に配信物を作る（2 分ほど）
python3 vm/serve.py
```

http://127.0.0.1:8000/ を開きます。`dist/site` のページとシナリオはソースへのシンボリックリンクなので、編集して再読み込みすれば反映されます（`python3 -m http.server` で配信すると、JS が古いキャッシュのまま読まれることがあります）。`vm/build.sh` を実行し直すのは、`vm/Dockerfile`、`vm/make-state.mjs`、`LICENSE.txt`（VM の `/LICENSE` にも入る）、v86 や xterm.js の版を変えたときだけです。OGP 画像とアイコンの元（`brand/*.html`）を直したときは、`vm/render-images.sh dist/site` で PNG を作り直します。

テストは `pnpm test` です。`dist/site` をヘッドレス Chrome で開き、tmux の操作、ハイライト、配置の通知、`run()`、CSP を確かめたうえで、シナリオの全レッスンを画面から通します（1 分ほど）。Chrome の場所が違うときは環境変数 `CHROME` で指定します。

## シナリオを書く

シナリオは `courses/<コース>/` にあり、形は `courses/linux/index.js` の先頭に書いてあります。`lesson-player.js` はシナリオの中身を知らず、`setup` と `check` を VM で実行して、終了コードだけを見て進めます。

新しいモジュールは `courses/linux/<名前>.js` に書き、`index.js` の `modules` に加えます。ステップのデータだけを書けば、次のものは共通の仕組みが受け持ちます。

| 共通の仕組み | 場所 |
|---|---|
| レッスン開始時の初期化と、できないときの VM の作り直し | `courses/linux/index.js` の `setup` |
| 環境が止まったときの表示 | `courses/linux/index.js` の `alive` |
| 判定の部品（`onScreen()`、`running()` など） | `courses/linux/common.js` |
| 全ステップの自動テスト | `pnpm test`（`do` を打って通す） |

```js
{
  id: 'split-right',
  say: '`Ctrl-b` のあと `%` で左右に分けます。',  // 指示
  do: ['C-b', '%'],                               // 正解の操作
  check: '[ $(tmux list-panes | wc -l) -eq 2 ]',  // 合格の条件
}
```

- **状態が変わらないコマンドの判定:** `ls` などは `onScreen()` で画面の内容を見ます。
- **`do` を必ず書く:** `pnpm test` が `do` を打って全ステップを通します。`check` が `do` を打ち終える前に成功するステップは失敗にします。指示を読み終える前に進んでしまうためです。
- **`check` は間違えた後でも正解できるように書く:** 操作の回数やペインの数ではなく、目的の状態を判定します。回数に頼ると、やり直しても合格できなくなります。
- **`setup` はやり直せるように書く:** 0 以外で終わると、ページを再読み込みして VM を作り直してからもう一度実行します。
- **ブラウザと OS に奪われるキーを教えない:** `Ctrl-w` はタブを閉じ、`Ctrl-Space` は macOS の入力切替と衝突し、Option は xterm.js の既定では Meta になりません。

## `<tmux-terminal>` の使い方

```html
<script type="module" src="./tmux-terminal.js"></script>
<tmux-terminal></tmux-terminal>
```

要素を置くと VM を読み込み、読み込み中は進捗バーを表示します。端末は 100×30 桁の固定です。要素を外すと VM を破棄し、付け直すと最初の状態から始まります。

| 名前 | 種類 | 内容 |
|---|---|---|
| `highlight(col, row, width, height)` | メソッド | 画面に矩形を重ねて描き、その要素を返す |
| `layout` | プロパティ | 最新のペインの配置。最初の通知までは `null` |
| `focus()` | メソッド | キー入力を端末へ向ける |
| `fit(width, height)` | メソッド | 文字盤が指定の大きさ（px）に収まるよう文字の大きさを変える。桁数と行数は変わらない。引数なしで元に戻す |
| `run(command)` | メソッド | VM でシェルコマンドを実行し、終了コードの Promise を返す |
| `tmux-layout` | イベント | ペインの配置が変わった。`detail` は `layout` と同じ形 |
| `tmux-hook` | イベント | tmux の操作の通知。`detail` は `split-window` か `new-window` |

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

- `layout` が `null` のあいだは VM の起動前なので、呼ぶと reject します。
- root として `/root` で実行します。標準入力は空で、出力は捨てられます。
- コマンドは 1 行だけで、複数を同時に呼ぶと順番に実行します。
- 10 秒で打ち切り、終了コードは 143 になります。
- 応答が 15 秒ないときや要素を外したときは reject します。利用者が VM の中で `lesson-agent` を止めても init が再起動するので、その後の呼び出しから復帰します。

## レッスンを書くときの注意

- **スクリプトは別ファイルにする:** CSP によりインラインスクリプトは動きません。同一オリジンの `.js` ファイルにして、`vm/build.sh` の最後の `ln -s` に追加してください。
- **VM からの値を信頼しない:** 利用者は VM の root なので、`echo 'layout …' >/dev/ttyS1` などで通知を偽装できます。`detail` を `innerHTML` に入れず、合否の判定を権限や認定に使わないでください。形式の合わない `layout` の行は捨てられます。
- **VM の時計は保存時刻のまま:** ビルド時の状態を復元するので、VM の中の時刻は正しくありません。ステータスバーの時刻は消してあります。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | ページ本体と CSP |
| `lesson-player.js` | シナリオを読み込み、レッスンを進める |
| `courses/` | シナリオと、モジュール共通の部品 |
| `tmux-terminal.js` | `<tmux-terminal>` 要素 |
| `brand/` | OGP 画像とアイコンの元の HTML |
| `vm/Dockerfile` | VM のイメージ、`run()` の窓口（`lesson-agent`）、`.tmux.conf`。**設定エラーがあると tmux はエラー表示で起動する** |
| `vm/build.sh` | 配信物のビルド。v86 と xterm.js の版もここで固定している |
| `vm/render-images.sh` | `brand/*.html` を Chrome で PNG にする |
| `vm/make-state.mjs` | VM を起動し、tmux が動いている状態を保存する。ページはここから復元する |
| `vm/serve.py` | 開発用の配信。ブラウザに毎回更新を確かめさせる |
| `vm/smoke.mjs` | `pnpm test` の中身 |

`tmux-layout` の行の形式を変えるときは、`vm/Dockerfile` の `NOTIFY_LAYOUT` と `tmux-terminal.js` の `PANE` を揃えて変更します。

## 公開する前に

- `dist/site` のページとシナリオはシンボリックリンクなので、`cp -RL dist/site <公開先>` で実体にしてから公開してください。
- Linux カーネルや BusyBox を配布することになるので、GPL への対応（ソースの提供など）が必要です。このリポジトリのライセンスを GPL にしても、この対応の代わりにはなりません。
- `<ユーザー>.github.io` は配下のプロジェクトでオリジンを共有します。`localStorage` などを使うなら、専用のドメインで公開してください。
- OGP の画像は絶対 URL でないと読まれません。`https://kamataryo.github.io/how-to-tmux/` 以外で公開するときは、`index.html` の `og:url` と `og:image` を書き換えてください。

## ライセンス

Copyright (C) 2026 kamataryo

このリポジトリのコードは [GPL-3.0-or-later](LICENSE.txt) です。配信物に含まれる v86、xterm.js、SeaBIOS と、VM のイメージの中身（Linux カーネル、BusyBox、tmux など）は、それぞれのライセンスに従います。

`LICENSE.txt` の 674 行目までは GPL の原文で、冒頭に変更を禁じる記述があるので編集しません。条項は 621 行目の `END OF TERMS AND CONDITIONS` までで、その後ろは適用のしかたの説明です。そこにあるプレースホルダ（`<year>` など）は自分の告知へ写して使う雛形なので原文のままにし、埋めた告知は 675 行目以降に書いています。
