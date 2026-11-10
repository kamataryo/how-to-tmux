// VM と端末の設定。ページ（vm-terminal.js）とビルド（vm/build.sh、vm/make-state.mjs）、シナリオの座標がここを見る。
// 状態ファイルは保存したときと同じ設定でないと復元できないので、v86 の設定は必ずここに書く。
// 値を変えたら vm/build.sh で VM を作り直すこと

// シリアルは端末サイズを伝えないので固定する。VM の stty にはビルド時に渡る。
// 桁数を変えたら index.html の @media の幅も直すこと
export const COLS = 100;
export const ROWS = 30;

export const STATE_FILE = 'images/state.bin.zst';

/** v86 に渡す設定のうち、保存する側と復元する側で揃える部分。base は配信物の場所（ページでは ''、Node では絶対パスに / を付けたもの） */
export const vmOptions = (base = '') => ({
  wasm_path: `${base}v86/v86.wasm`,
  bios: { url: `${base}bios/seabios.bin` },
  vga_bios: { url: `${base}bios/vgabios.bin` },
  autostart: true,
  // 実際の使用量は 15 MB 程度。ローダーが initrd を 64 MiB の位置に置くので 64 MiB 以下では起動できない
  memory_size: 128 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  uart1: true,
  filesystem: { baseurl: `${base}images/rootfs-flat` },
});
