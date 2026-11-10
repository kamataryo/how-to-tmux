// Node で VM を起動し、コースの最初の画面（course.vm.boot を打った後）まで進めた状態を保存する。ページはこの状態から復元する。
// 使い方: node make-state.mjs <site の絶対パス> <fs.json の絶対パス>

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [site, fsJson] = process.argv.slice(2);
const { V86 } = await import(path.join(site, 'v86/libv86.mjs'));
const { default: course } = await import(path.join(site, 'course.mjs'));
const { STATE_FILE, vmOptions } = await import('../vm-config.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const options = vmOptions(`${site}/`);
const emulator = new V86({
  ...options,
  bzimage_initrd_from_filesystem: true,
  // ignoreqv: v86 のファイルは qid.version が 0 で、Linux はそれをキャッシュしない印として扱う。付けないとコマンドを起動するたびに HTTP で取り直す
  cmdline: 'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose,ignoreqv modules=virtio_pci tsc=reliable init_on_free=on',
  filesystem: { ...options.filesystem, basefs: fsJson },
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
await waitFor(/localhost:~# (\x1b\[6n)?$/, 'ログイン');
if (course.vm?.boot) {
  emulator.serial0_send(`${course.vm.boot}\n`);
  await waitFor(new RegExp(course.vm.booted), `${course.vm.boot} の起動`);
}

// 空きページを 0 にして圧縮を効かせる。実行中のプロセスのページは残る。
// boot がシェルに戻らないと（.tmux.conf にエラーがあると tmux はエラー表示を開く）、ここで打った文字はシェルに届かない。
// そのまま保存すると壊れた状態を配ることになるので、シェルが応答しなければビルドを失敗させる
// （打った文字列そのものに一致しないよう、結果は計算させる）
emulator.serial0_send('sync; echo 3 >/proc/sys/vm/drop_caches; echo shell-ok-$((6*7)); clear\n');
await waitFor(/shell-ok-42/, 'シェルの応答');
await sleep(10_000);

const file = path.join(site, STATE_FILE.replace(/\.zst$/, ''));
writeFileSync(file, new Uint8Array(await emulator.save_state()));
execFileSync('zstd', ['-19', '-f', '--rm', '-q', file]);
console.log(`保存: ${file}.zst`);
await emulator.destroy();
process.exit(0);
