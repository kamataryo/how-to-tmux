// 配信物をヘッドレス Chrome で開き、本物の tmux が動くことと、CSP で壊れていないことを確かめる。
// 使い方: node vm/smoke.mjs [site のパス]（既定は dist/site）。ブラウザは環境変数 CHROME で変更できる

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const site = process.argv[2] ?? 'dist/site';
const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8799;
const origin = `http://127.0.0.1:${PORT}`;
assert.ok(existsSync(path.join(site, 'images/state.bin.zst')), `${site} に配信物がありません。先に vm/build.sh を実行してください`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn('python3', ['-I', '-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', site], { stdio: 'ignore' });
const profile = mkdtempSync(path.join(tmpdir(), 'tmux-forcage-smoke-'));
const chrome = spawn(chromePath, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

async function waitUntil(what, check, timeout = 30_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() - started < timeout, `${what} を確認できませんでした`);
    await sleep(100);
  }
}

try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await waitUntil('Chrome の起動', () => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n'));
  const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve) => ws.addEventListener('open', resolve));

  let nextId = 1;
  const pending = new Map();
  const problems = [];
  const requested = [];
  ws.addEventListener('message', ({ data }) => {
    const { id, result, error, method, params } = JSON.parse(data);
    if (id) {
      const { resolve, reject } = pending.get(id);
      pending.delete(id);
      return error ? reject(new Error(JSON.stringify(error))) : resolve(result);
    }
    if (method === 'Log.entryAdded' && params.entry.level === 'error') problems.push(params.entry.text);
    if (method === 'Runtime.exceptionThrown') problems.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    if (method === 'Network.requestWillBeSent') requested.push(params.request.url);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await Promise.all(['Page', 'Runtime', 'Log', 'Network'].map((domain) => page(`${domain}.enable`)));
  await page('Emulation.setFocusEmulationEnabled', { enabled: true });

  const evaluate = async (expression) => (await page('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const screen = () => evaluate(`[...document.querySelectorAll('.xterm-rows > div')].map((row) => row.textContent).join('\\n')`);
  const press = async (key, code, vk, modifiers, text) => {
    await page('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  };

  await waitUntil('サーバーの起動', () => fetch(origin).then((r) => r.ok).catch(() => false));
  await page('Page.navigate', { url: `${origin}/index.html` });
  await waitUntil('tmux のステータスライン', async () => (await screen())?.includes('[lesson]'));
  await evaluate(`window.hooks = []; addEventListener('tmux-hook', (e) => hooks.push(e.detail)); window.tmux = document.querySelector('tmux-terminal'); tmux.focus();`);
  await waitUntil('起動時の配置', () => evaluate(`tmux.layout?.panes.length === 1`));

  // ハイライトが文字の位置と一致する（文字盤の外へはみ出さない）
  const offset = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.xterm-rows > div')].at(-1);
    const range = document.createRange();
    const text = document.createTreeWalker(row, NodeFilter.SHOW_TEXT).nextNode();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    const expected = range.getBoundingClientRect();
    const box = tmux.highlight(0, 29, 8, 1);
    const actual = box.getBoundingClientRect();
    box.remove();
    return Math.max(...['left', 'top', 'width', 'height'].map((side) => Math.abs(actual[side] - expected[side])));
  })()`);
  assert.ok(offset < 1, `ハイライトが文字から ${offset}px ずれています`);

  await page('Input.insertText', { text: 'tmux -V' });
  await press('Enter', 'Enter', 13, 0, '\r');
  // Enter の直後に prefix を押す。assume-paste-time が効いていると貼り付けと誤判定されて分割できない
  await press('b', 'KeyB', 66, 2);
  await press('%', 'Digit5', 53, 8, '%');
  await waitUntil('tmux のバージョン表示', async () => (await screen()).includes('tmux 3.'));
  await waitUntil('Ctrl-b % の tmux-hook', () => evaluate(`hooks.includes('split-window')`));
  await waitUntil('ペインの境界線', async () => (await screen()).includes('│'));
  await waitUntil('分割後の配置', () => evaluate(`tmux.layout.panes.length === 2 && tmux.layout.panes[1].active`));

  // 形式の合わない配置の通知は捨てる
  const before = await evaluate(`JSON.stringify(tmux.layout)`);
  await page('Input.insertText', { text: `echo 'layout <img src=x>' >/dev/ttyS1; echo checked >/dev/ttyS1` });
  await press('Enter', 'Enter', 13, 0, '\r');
  await waitUntil('不正な通知の後の通知', () => evaluate(`hooks.includes('checked')`));
  assert.equal(await evaluate(`JSON.stringify(tmux.layout)`), before, '不正な通知で配置が変わりました');
  assert.ok(!(await evaluate(`hooks.some((line) => line.startsWith('layout'))`)), '不正な通知が tmux-hook に流れました');

  assert.deepEqual(problems, [], 'コンソールにエラーがあります（CSP 違反を含む）');
  const external = requested.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith('blob:') && !url.startsWith('data:'));
  assert.deepEqual(external, [], '同一オリジン以外への通信があります');
  console.log(`OK: ${requested.length} リクエスト、すべて同一オリジン`);
} finally {
  chrome.kill();
  server.kill();
}
process.exit(0);
