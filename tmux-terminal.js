// <tmux-terminal> : ブラウザ内の Linux VM（v86）で動く本物の tmux を表示する。使い方は README.md を参照。
//
// VM の中は利用者が root で自由に操作できるので、VM からの出力はすべて信頼できない入力として扱う。
// イベントの detail を innerHTML に入れない。レッスンの判定は偽装できる前提で、権限や認定には使わない。

import { V86 } from './v86/libv86.mjs';
import { Terminal } from './xterm/xterm.mjs';

const COLS = 100; // vm/Dockerfile の stty と揃える
const ROWS = 30;
const encoder = new TextEncoder();

// 例: "layout 0 0 %0:0:0:50:29:1 %1:51:0:49:29:0"（ウィンドウ番号、ズーム中か、ペインごとの id:桁:行:幅:高さ:アクティブか）
// VM 由来なので形式が合わないものは捨てる。vm/Dockerfile の NOTIFY_LAYOUT と揃える
const PANE = String.raw`%\d+:\d+:\d+:\d+:\d+:[01]`;
const LAYOUT_LINE = new RegExp(`^layout (\\d+) ([01]) (${PANE}(?: ${PANE})*)$`);

// vm/Dockerfile の lesson-agent と揃える。lesson-agent はコマンドを 10 秒で打ち切るので、それより少し長く待つ
const RUN_RESULT = /^run (\d+) (\d+)$/;
const RUN_TIMEOUT = 15_000;

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

class TmuxTerminal extends HTMLElement {
  #vm;
  #term;
  #overlay;
  #layout = null;
  #runs = new Map();
  #lastRun = 0;

  connectedCallback() {
    const progress = document.createElement('progress');
    progress.setAttribute('aria-label', '環境を読み込み中');
    progress.style.width = '100%';
    this.replaceChildren(progress);

    // VM の出力でリンクを開かせない（講座にはリンクは要らず、偽リンクの踏み台にもなる）
    const term = new Terminal({
      cols: COLS,
      rows: ROWS,
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: 14,
      linkHandler: { activate() {} },
    });
    term.open(this);
    this.#term = term;

    // highlight() の置き場。文字盤と同じ大きさなので、位置を % で指定すればスクロールしてもずれない。
    // 座標は VM から偽装できるが、はみ出した分は overflow で切れる
    this.#overlay = document.createElement('div');
    this.#overlay.className = 'tmux-highlights';
    this.#overlay.setAttribute('aria-hidden', 'true');
    Object.assign(this.#overlay.style, { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 10 });
    term.element.querySelector('.xterm-screen').append(this.#overlay);

    const vm = new V86({
      wasm_path: 'v86/v86.wasm',
      bios: { url: 'bios/seabios.bin' },
      vga_bios: { url: 'bios/vgabios.bin' },
      autostart: true,
      memory_size: 128 * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      uart1: true,
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
      filesystem: { baseurl: 'images/rootfs-flat' },
      initial_state: { url: 'images/state.bin.zst' },
    });
    this.#vm = vm;

    // 転送の大半は状態ファイルなので、その進捗だけを見せる。それまでは不確定表示のまま
    vm.add_listener('download-progress', ({ file_name, lengthComputable, loaded, total }) => {
      if (!file_name.endsWith('state.bin.zst') || !lengthComputable) return;
      progress.max = total;
      progress.value = loaded;
    });
    vm.add_listener('download-error', () => progress.replaceWith('読み込みに失敗しました。再読み込みしてください。'));

    const send = (data) => vm.serial_send_bytes(0, encoder.encode(data));
    term.onData(send);

    vm.add_listener('emulator-started', () => {
      progress.remove();
      term.focus();
      send('\x02r'); // 復元直後の xterm.js は空なので、tmux に再描画させる
    });

    // 1 バイトずつ届くので、まとめて xterm.js へ渡す
    let pending = [];
    vm.add_listener('serial0-output-byte', (byte) => {
      if (!pending.length) {
        queueMicrotask(() => {
          term.write(Uint8Array.from(pending));
          pending = [];
        });
      }
      pending.push(byte);
    });

    let line = '';
    vm.add_listener('serial1-output-byte', (byte) => {
      const char = String.fromCharCode(byte);
      if (char === '\n') {
        this.#onVmLine(line.trim());
        line = '';
      } else {
        line = (line + char).slice(-4096); // VM が改行なしで流し続けても溜めない
      }
    });
  }

  disconnectedCallback() {
    this.#layout = null;
    for (const run of this.#runs.values()) run.reject(new Error('VM を破棄しました'));
    this.#vm.destroy();
    this.#term.dispose();
  }

  #onVmLine(line) {
    if (line.startsWith('run ')) {
      const [, id, code] = RUN_RESULT.exec(line) ?? [];
      this.#runs.get(Number(id))?.resolve(Number(code));
      return;
    }
    if (!line.startsWith('layout ')) {
      this.dispatchEvent(new CustomEvent('tmux-hook', { bubbles: true, detail: line }));
      return;
    }
    const layout = parseLayout(line);
    if (!layout) return;
    this.#layout = layout;
    this.dispatchEvent(new CustomEvent('tmux-layout', { bubbles: true, detail: layout }));
  }

  focus() {
    this.#term?.focus();
  }

  /** 最後に届いたペインの配置。起動直後の最初の通知までは null */
  get layout() {
    return this.#layout;
  }

  /** VM でシェルコマンドを 1 行実行し、終了コードを返す。出力は捨てる。結果は利用者が偽装できる */
  async run(command) {
    if (!this.#layout) throw new Error('VM の起動前です');
    if (command.includes('\n')) throw new TypeError('コマンドは 1 行にしてください');
    const id = ++this.#lastRun;
    const run = Promise.withResolvers();
    this.#runs.set(id, run);
    const timer = setTimeout(() => run.reject(new Error(`応答がありません: ${command}`)), RUN_TIMEOUT);
    this.#vm.serial_send_bytes(1, encoder.encode(`${id} ${command}\n`));
    try {
      return await run.promise;
    } finally {
      clearTimeout(timer);
      this.#runs.delete(id);
    }
  }

  /** 文字盤の桁・行（0 始まり）で矩形を重ねて描く。返り値は普通の要素で、remove() で消せる */
  highlight(col, row, width, height) {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      left: `${(col / COLS) * 100}%`,
      top: `${(row / ROWS) * 100}%`,
      width: `${(width / COLS) * 100}%`,
      height: `${(height / ROWS) * 100}%`,
      border: '2px solid #fc0',
      background: '#ffcc0033',
    });
    return this.#overlay.appendChild(box);
  }
}

customElements.define('tmux-terminal', TmuxTerminal);
