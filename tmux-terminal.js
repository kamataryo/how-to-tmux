// <tmux-terminal> : ブラウザ内の Linux VM（v86）で動く本物の tmux を表示する。
// 端末は 100×30 桁で固定（vm/Dockerfile の stty と揃える）。
// tmux の操作は tmux-hook イベントで通知する（detail は "split-window" など。bubbles）。
//
// VM の中は利用者が root で自由に操作できるので、VM からの出力はすべて信頼できない入力として扱う。
// tmux-hook の detail を innerHTML に入れない。レッスンの判定は偽装できる前提で、権限や認定には使わない。

import { V86 } from './v86/libv86.mjs';
import { Terminal } from './xterm/xterm.mjs';

const encoder = new TextEncoder();

class TmuxTerminal extends HTMLElement {
  #vm;
  #term;

  connectedCallback() {
    const progress = document.createElement('progress');
    progress.setAttribute('aria-label', '環境を読み込み中');
    progress.style.width = '100%';
    this.replaceChildren(progress);

    // VM の出力でリンクを開かせない（講座にはリンクは要らず、偽リンクの踏み台にもなる）
    const term = new Terminal({
      cols: 100,
      rows: 30,
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: 14,
      linkHandler: { activate() {} },
    });
    term.open(this);
    this.#term = term;

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

    let hook = '';
    vm.add_listener('serial1-output-byte', (byte) => {
      const char = String.fromCharCode(byte);
      if (char === '\n') {
        this.dispatchEvent(new CustomEvent('tmux-hook', { bubbles: true, detail: hook.trim() }));
        hook = '';
      } else {
        hook = (hook + char).slice(-256); // VM が改行なしで流し続けても溜めない
      }
    });
  }

  disconnectedCallback() {
    this.#vm.destroy();
    this.#term.dispose();
  }

  focus() {
    this.#term?.focus();
  }
}

customElements.define('tmux-terminal', TmuxTerminal);
