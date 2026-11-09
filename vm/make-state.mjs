// Node で VM を起動し、tmux の中のプロンプトまで進めた状態を保存する。ページはこの状態から復元する。
// 使い方: node make-state.mjs <site の絶対パス> <fs.json の絶対パス>

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [site, fsJson] = process.argv.slice(2);
const { V86 } = await import(path.join(site, 'v86/libv86.mjs'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const emulator = new V86({
  wasm_path: path.join(site, 'v86/v86.wasm'),
  bios: { url: path.join(site, 'bios/seabios.bin') },
  vga_bios: { url: path.join(site, 'bios/vgabios.bin') },
  autostart: true,
  // 実際の使用量は 15 MB 程度。ローダーが initrd を 64 MiB の位置に置くので 64 MiB 以下では起動できない
  memory_size: 128 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  uart1: true,
  bzimage_initrd_from_filesystem: true,
  cmdline: 'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable init_on_free=on',
  filesystem: {
    baseurl: path.join(site, 'images/rootfs-flat'),
    basefs: fsJson,
  },
});

let screen = '';
emulator.add_listener('serial0-output-byte', (byte) => {
  screen += String.fromCharCode(byte);
});

async function waitFor(pattern, what) {
  const started = Date.now();
  while (!pattern.test(screen)) {
    if (Date.now() - started > 120_000) throw new Error(`${what} を待ちきれませんでした:\n${screen.slice(-2000)}`);
    await sleep(100);
  }
  console.log(`${what}: ${Date.now() - started}ms`);
}

// BusyBox の ash はプロンプトの直後にカーソル位置の問い合わせを送る
await waitFor(/forcage:~# (\x1b\[6n)?$/, 'ログイン');
emulator.serial0_send('tmux new -s lesson\n');
await waitFor(/\[lesson\]/, 'tmux 起動');

// 空きページを 0 にして圧縮を効かせる。実行中のプロセスのページは残る
emulator.serial0_send('sync; echo 3 >/proc/sys/vm/drop_caches; clear\n');
await sleep(10_000);

const file = path.join(site, 'images/state.bin');
writeFileSync(file, new Uint8Array(await emulator.save_state()));
execFileSync('zstd', ['-19', '-f', '--rm', '-q', file]);
console.log(`保存: ${file}.zst`);
await emulator.destroy();
process.exit(0);
