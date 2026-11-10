// Linux コース。シナリオは関数を含まない純粋なデータで、JSON.stringify しても何も失われない。
//
// Course  { id, title, terminal?, vm?, setup?, alive?, license?, modules: Module[] }
//   terminal   端末の要素名。サイト直下の同じ名前の .js が定義する。省略すると vm-terminal（tmux の通知がない素の端末）
//   vm         VM のビルドで使う。VM に入れるものは、このディレクトリの vm/Dockerfile に書く
//     boot       ログイン直後のシェルに打つ 1 行のコマンド。その結果の画面を、ページを開いたときの最初の状態として保存する
//     booted     boot を打ったあと、画面に現れるのを待つ正規表現（文字列で書く）
//   setup      どのレッスンでも開始時に実行する 1 行のシェルコマンド。前のレッスンの状態が残っていても同じ状態から始める。
//              0 以外で終わると、ページを再読み込みして VM を作り直してからもう一度実行する
//   alive      環境が動いていれば成功する 1 行のシェルコマンド。失敗している間は、やり直すよう画面に表示する
//   license    ライセンスを端末に表示する 1 行のシェルコマンド。失敗すると新しいタブで開く
// Module  { id, title, lessons: Lesson[] }  配列の順が受講順
// Lesson  { id, title, goal, setup?, steps: Step[] }
//   setup      そのレッスンだけの準備。Course の setup の後に実行し、失敗したときの扱いも同じ
// Step    { id, say, do?, check?, hint?, highlight? }
//   say        学習者に見せる指示。プレーンテキストで、`…` だけをキーやコマンドとして表示する
//   do         正解の操作。tmux send-keys の記法で、要素はキー名かそのまま打つ文字列。「答えを見る」と npm test に使う
//   check      VM で実行する 1 行のシェルコマンド。繰り返し実行し、終了コード 0 で合格。省略すると「次へ」で進む
//   hint       つまずいたときに見せる補足
//   highlight  [桁, 行, 幅, 高さ] か 'active-pane'
//
// check は `do` を打ち終える前には失敗し、後には成功すること（途中で成功すると読む前に次へ進んでしまう）。
// 結果は利用者が偽装できるので、権限や認定には使わない。

import { ALIVE, RESET, SESSION, SHOW_LICENSE } from './tmux-common.js';
import tmux from './tmux.js';

export default {
  id: 'linux',
  title: 'How to tmux',
  terminal: 'tmux-terminal',
  vm: { boot: `tmux new -s ${SESSION}`, booted: `\\[${SESSION}\\]` },
  setup: RESET,
  alive: ALIVE,
  license: SHOW_LICENSE,
  modules: [tmux],
};
