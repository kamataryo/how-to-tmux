// <vm-terminal> : ブラウザ内の Linux VM（v86）のシリアル端末を xterm.js で表示する。使い方は API.md を参照。
// VM の中で何が動いているかは知らない。tmux 向けの拡張は tmux-terminal.js にある。
//
// VM の中は利用者が root で自由に操作できるので、VM からの出力はすべて信頼できない入力として扱う。
// イベントの detail を innerHTML に入れない。レッスンの判定は偽装できる前提で、権限や認定には使わない。

import { V86 } from './v86/libv86.mjs';
import { Terminal } from './xterm/xterm.mjs';
import { COLS, ROWS, STATE_FILE, vmOptions } from './vm-config.js';

const FONT_SIZE = 14;
const encoder = new TextEncoder();

// vm/Dockerfile の lesson-agent と揃える。lesson-agent はコマンドを 10 秒で打ち切るので、それより少し長く待つ
const RUN_RESULT = /^run (\d+) (\d+)$/;
const RUN_TIMEOUT = 15_000;
const PING_TIMEOUT = 2_000;
const MAX_COLS = 300; // 極端に大きな画面でも、VM の描画が追いつく範囲にとどめる
const MAX_ROWS = 100;
const MIN_COLS = 40; // これより狭い画面では、端末をスクロールして見る
const MIN_ROWS = 10;

export class VmTerminal extends HTMLElement {
  #vm;
  #term;
  #overlay;
  #ready = false;
  #cols = COLS;
  #rows = ROWS;
  #runs = new Map();
  #lastRun = 0;

  connectedCallback() {
    const progress = document.createElement('progress');
    progress.setAttribute('aria-label', '環境を読み込み中');
    // 文字盤の上端に重ねる。場所を取らせると、出たり消えたりするたびに端末が上下に動く
    this.style.position = 'relative';
    Object.assign(progress.style, { position: 'absolute', top: 0, left: 0, zIndex: 20, width: '100%' });
    this.replaceChildren(progress);

    // VM の出力でリンクを開かせない（講座にはリンクは要らず、偽リンクの踏み台にもなる）
    const term = new Terminal({
      cols: COLS,
      rows: ROWS,
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: FONT_SIZE,
      linkHandler: { activate() {} },
      theme: { black: '#000000' }, // 既定の黒は灰色がかっていて、緑のステータスバーの上で読みにくい
    });
    term.open(this);
    this.#term = term;

    // highlight() の置き場。文字盤と同じ大きさなので、位置を % で指定すればスクロールしてもずれない。
    // 座標は VM から偽装できるが、はみ出した分は overflow で切れる
    this.#overlay = document.createElement('div');
    this.#overlay.className = 'terminal-highlights';
    this.#overlay.setAttribute('aria-hidden', 'true');
    Object.assign(this.#overlay.style, { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 10 });
    term.element.querySelector('.xterm-screen').append(this.#overlay);

    const vm = new V86({
      ...vmOptions(),
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
      initial_state: { url: STATE_FILE },
    });
    this.#vm = vm;

    // 転送の大半は状態ファイルなので、その進捗だけを見せる。それまでは不確定表示のまま
    vm.add_listener('download-progress', ({ file_name, lengthComputable, loaded, total }) => {
      if (!file_name.endsWith(STATE_FILE.split('/').pop()) || !lengthComputable) return;
      progress.max = total;
      progress.value = loaded;
    });
    vm.add_listener('download-error', () => progress.replaceWith('読み込みに失敗しました。再読み込みしてください。'));

    term.onData((data) => this.send(data));

    vm.add_listener('emulator-started', () => {
      progress.remove();
      term.focus();
      this.vmStarted();
      this.#waitForAgent(vm);
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
    this.#ready = false;
    this.#cols = COLS; // 付け直すと VM は最初の状態から始まる
    this.#rows = ROWS;
    for (const run of this.#runs.values()) run.reject(new Error('VM を破棄しました'));
    // 読み込み中の v86 は破棄できず、放っておくと読み込み後に動き出すので、起動を待って破棄する
    const vm = this.#vm;
    this.#vm = null;
    if (vm.is_running()) vm.destroy();
    else vm.add_listener('emulator-started', () => vm.destroy());
    this.#term.dispose();
  }

  // lesson-agent が応答するまで確かめ続ける。復元した VM ではすぐ応答し、応答がなければ lesson-agent の再起動を待つことになる
  async #waitForAgent(vm) {
    while (this.#vm === vm) {
      const code = await this.#request('true', PING_TIMEOUT).catch(() => null);
      if (this.#vm !== vm) return;
      if (code !== 0) continue;
      this.#ready = true;
      this.dispatchEvent(new CustomEvent('vm-ready', { bubbles: true }));
      return;
    }
  }

  #onVmLine(line) {
    if (line.startsWith('run ')) {
      const [, id, code] = RUN_RESULT.exec(line) ?? [];
      this.#runs.get(Number(id))?.resolve(Number(code));
      return;
    }
    this.vmLine(line);
  }

  async #request(command, timeout) {
    const id = ++this.#lastRun;
    const run = Promise.withResolvers();
    this.#runs.set(id, run);
    const timer = setTimeout(() => run.reject(new Error(`応答がありません: ${command}`)), timeout);
    this.#vm.serial_send_bytes(1, encoder.encode(`${id} ${command}\n`));
    try {
      return await run.promise;
    } finally {
      clearTimeout(timer);
      this.#runs.delete(id);
    }
  }

  /** 拡張用。VM が動き出したときに呼ばれる。この時点では run() はまだ使えない */
  vmStarted() {}

  /** 拡張用。VM が /dev/ttyS1 に書いた行（run() の応答を除く）ごとに呼ばれる。上書きしなければ vm-line イベントにする */
  vmLine(line) {
    this.dispatchEvent(new CustomEvent('vm-line', { bubbles: true, detail: line }));
  }

  /** run() を使えるか。VM が動き出して lesson-agent が応答すると true になり、vm-ready イベントが出る */
  get ready() {
    return this.#ready;
  }

  focus() {
    this.#term?.focus();
  }

  /** 利用者が打ったのと同じように、端末へ文字を送る */
  send(data) {
    this.#vm?.serial_send_bytes(0, encoder.encode(data));
  }

  // 1 文字の大きさ（px）。文字の大きさは変えないので、桁数と行数が変わっても同じ
  #cell() {
    const screen = this.#term.element.querySelector('.xterm-screen');
    return { width: screen.offsetWidth / this.#cols, height: screen.offsetHeight / this.#rows };
  }

  /** 元の桁数と行数のときの文字盤の大きさ（px）。要素を置く前は null */
  get naturalSize() {
    if (!this.isConnected) return null;
    const cell = this.#cell();
    return { width: cell.width * COLS, height: cell.height * ROWS };
  }

  /** 今の桁数と行数。fill() で変わる */
  get cols() {
    return this.#cols;
  }

  get rows() {
    return this.#rows;
  }

  /**
   * 文字の大きさを変えずに、width×height（px）に収まる桁数と行数にする。元より少なくも多くもなる。引数なしで元の桁数と行数へ戻す。
   * VM の端末にも同じ大きさを伝えるので、中で動いているプログラムは端末の大きさが変わったときと同じように描き直す。
   * VM の起動前は何もしない
   */
  async fill(width, height) {
    if (!this.#ready) return;
    let [cols, rows] = [COLS, ROWS];
    if (width) {
      // 文字盤の大きさは整数に丸められているので、ちょうど収まる大きさで 1 つ減らさないよう少し余裕を見る
      const cell = this.#cell();
      cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor((width + 0.5) / cell.width)));
      rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor((height + 0.5) / cell.height)));
    }
    if (cols === this.#cols && rows === this.#rows) return;
    [this.#cols, this.#rows] = [cols, rows];
    this.#term.resize(cols, rows);
    // シリアルは大きさを伝えないので、VM の中から端末に設定する。動いているプログラムには SIGWINCH が届く
    await this.#request(`stty -F /dev/ttyS0 rows ${rows} cols ${cols}`, RUN_TIMEOUT).catch(() => null);
  }

  /** VM でシェルコマンドを 1 行実行し、終了コードを返す。出力は捨てる。結果は利用者が偽装できる */
  async run(command) {
    if (!this.#ready) throw new Error('VM の起動前です');
    if (command.includes('\n')) throw new TypeError('コマンドは 1 行にしてください');
    return this.#request(command, RUN_TIMEOUT);
  }

  /** 文字盤の桁・行（0 始まり）で矩形を重ねて描く。負の行は下から数える（-1 が最下行）。返り値は普通の要素で、remove() で消せる */
  highlight(col, row, width, height) {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      left: `${(col / this.#cols) * 100}%`,
      top: `${((row < 0 ? this.#rows + row : row) / this.#rows) * 100}%`,
      width: `${(width / this.#cols) * 100}%`,
      height: `${(height / this.#rows) * 100}%`,
      border: '2px solid #fc0',
      background: '#ffcc001a', // 下の文字が読めるよう薄くする
    });
    return this.#overlay.appendChild(box);
  }
}

customElements.define('vm-terminal', VmTerminal);
