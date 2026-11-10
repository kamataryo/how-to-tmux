// <tmux-terminal> : <vm-terminal> に、VM の中の tmux からの通知（ペインの配置と操作）を加えたもの。使い方は API.md を参照。
// 通知を出すのは VM の ~/.tmux.conf のフックで、courses/linux/vm/Dockerfile にある。
//
// VM 由来の値は信頼できない入力として扱う（vm-terminal.js の先頭を参照）。

import { VmTerminal } from './vm-terminal.js';

// 例: "layout 0 0 %0:0:0:50:29:1 %1:51:0:49:29:0"（ウィンドウ番号、ズーム中か、ペインごとの id:桁:行:幅:高さ:アクティブか）
// VM 由来なので形式が合わないものは捨てる。.tmux.conf の NOTIFY_LAYOUT と揃える
const PANE = String.raw`%\d+:\d+:\d+:\d+:\d+:[01]`;
const LAYOUT_LINE = new RegExp(`^layout (\\d+) ([01]) (${PANE}(?: ${PANE})*)$`);

function parseLayout(line) {
  const match = LAYOUT_LINE.exec(line);
  if (!match) return null;
  const [, window, zoomed, panes] = match;
  return {
    window: Number(window),
    zoomed: zoomed === '1',
    panes: panes.split(' ').map((pane) => {
      const [id, col, row, width, height, active] = pane.split(':');
      return { id, col: Number(col), row: Number(row), width: Number(width), height: Number(height), active: active === '1' };
    }),
  };
}

class TmuxTerminal extends VmTerminal {
  #layout = null;

  disconnectedCallback() {
    this.#layout = null;
    super.disconnectedCallback();
  }

  vmStarted() {
    this.send('\x02r'); // 復元直後の xterm.js は空なので、tmux に再描画させる。このとき配置の通知も届く
  }

  vmLine(line) {
    if (!line.startsWith('layout ')) {
      this.dispatchEvent(new CustomEvent('tmux-hook', { bubbles: true, detail: line }));
      return;
    }
    const layout = parseLayout(line);
    if (!layout) return;
    this.#layout = layout;
    this.dispatchEvent(new CustomEvent('tmux-layout', { bubbles: true, detail: layout }));
  }

  /** 最後に届いたペインの配置。起動直後の最初の通知までは null */
  get layout() {
    return this.#layout;
  }
}

customElements.define('tmux-terminal', TmuxTerminal);
