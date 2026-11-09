// 配信物をヘッドレス Chrome で開き、本物の tmux が動くことと、CSP で壊れていないことを確かめる。
// 使い方: node vm/smoke.mjs [site のパス]（既定は dist/site）。ブラウザは環境変数 CHROME で変更できる

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import course from '../courses/linux/index.js';

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

  const evaluate = async (expression) => (await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const screen = () => evaluate(`[...document.querySelectorAll('.xterm-rows > div')].map((row) => row.textContent).join('\\n')`);
  const press = async (key, code, vk, modifiers, text) => {
    await page('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  };

  await waitUntil('サーバーの起動', () => fetch(origin).then((r) => r.ok).catch(() => false));
  await page('Page.navigate', { url: `${origin}/index.html` });
  const currentStep = () => evaluate(`document.querySelector('[aria-current="step"]')?.dataset.step`);
  const firstStep = course.modules[0].lessons[0].steps[0];
  await waitUntil('tmux のステータスライン', async () => (await screen())?.includes('[lesson]'));
  await waitUntil('最初のレッスンの準備', async () => (await currentStep()) === firstStep.id);
  await evaluate(`window.hooks = []; addEventListener('tmux-hook', (e) => hooks.push(e.detail)); window.tmux = document.querySelector('tmux-terminal'); tmux.focus();`);
  await waitUntil('起動時の配置', () => evaluate(`tmux.layout?.panes.length === 1`));
  await waitUntil('setup で番号を振り直した後のウィンドウ番号', () => evaluate(`tmux.layout.window === 0`));

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
  await page('Input.insertText', { text: `echo 'layout <img src=x>' >/dev/ttyS1; echo 'run x' >/dev/ttyS1; echo checked >/dev/ttyS1` });
  await press('Enter', 'Enter', 13, 0, '\r');
  await waitUntil('不正な通知の後の通知', () => evaluate(`hooks.includes('checked')`));
  assert.equal(await evaluate(`JSON.stringify(tmux.layout)`), before, '不正な通知で配置が変わりました');
  assert.ok(!(await evaluate(`hooks.some((line) => /^(layout|run)\\b/.test(line))`)), '不正な通知が tmux-hook に流れました');

  // run() はページから VM へ依頼して終了コードを受け取る。ペインと同じ環境で動き、画面と tmux-hook は汚さない
  const run = (command) => evaluate(`tmux.run(${JSON.stringify(command)})`);
  await page('Input.insertText', { text: 'clear' });
  await press('Enter', 'Enter', 13, 0, '\r');
  await waitUntil('画面の消去', async () => !(await screen()).includes('checked'));
  const screenBefore = await screen();
  assert.equal(await run('exit 7'), 7);
  assert.equal(await run('[ $(tmux list-panes | wc -l) -eq 2 ]'), 0, 'VM の状態を読めません');
  assert.equal(await run('[ $(tmux list-panes | wc -l) -eq 3 ]'), 1);
  assert.equal(await run('test -f ~/.tmux.conf'), 0, 'HOME がペインと違います');
  assert.equal(await run('echo run-output; echo run-error >&2'), 0);
  assert.equal(await screen(), screenBefore, 'run() の出力が画面に出ました');
  assert.ok(!(await evaluate(`hooks.some((line) => line.startsWith('run-'))`)), 'run() の出力が tmux-hook に流れました');
  assert.equal(await evaluate(`tmux.run('true\\nfalse').catch((error) => error.name)`), 'TypeError');
  assert.equal(await evaluate(`document.createElement('tmux-terminal').run('true').catch((error) => error.message)`), 'VM の起動前です');

  // F6 で端末と欄を行き来できる（端末は Tab も受け取るので、これがキーボードで欄へ移る唯一の方法）
  await press('F6', 'F6', 117, 0);
  assert.equal(await evaluate(`document.activeElement.id`), 'next', 'F6 で欄へ移れません');
  await press('F6', 'F6', 117, 0);
  assert.ok(await evaluate(`tmux.contains(document.activeElement)`), 'F6 で端末へ戻れません');

  // フォーカスが端末から外れても、余白のクリックやキー入力で戻る
  await evaluate(`document.activeElement.blur(); document.body.click()`);
  assert.ok(await evaluate(`tmux.contains(document.activeElement)`), '余白のクリックで端末へ戻れません');
  const splits = () => evaluate(`hooks.filter((hook) => hook === 'split-window').length`);
  const splitsBefore = await splits();
  await evaluate(`getSelection().selectAllChildren(document.getElementById('goal')); document.activeElement.blur()`);
  await press('b', 'KeyB', 66, 2);
  await press('%', 'Digit5', 53, 8, '%');
  await waitUntil('文字の選択中に打った Ctrl-b %', async () => (await splits()) > splitsBefore);

  // シナリオを画面から 1 周する。do を打ち終えるまでは合格せず、打ち終えると合格して次へ進むこと
  const reloadedTerminal = () => evaluate(`window.tmux = document.querySelector('tmux-terminal'); true`);
  await page('Page.reload');
  await waitUntil('再読み込み後の準備', async () => (await currentStep().catch(() => null)) === firstStep.id);
  await reloadedTerminal();

  const NAMED_KEYS = {
    Enter: ['Enter', 'Enter', 13, 0, '\r'],
    Space: [' ', 'Space', 32, 0, ' '],
    Up: ['ArrowUp', 'ArrowUp', 38, 0],
    Down: ['ArrowDown', 'ArrowDown', 40, 0],
    Left: ['ArrowLeft', 'ArrowLeft', 37, 0],
    Right: ['ArrowRight', 'ArrowRight', 39, 0],
    PageUp: ['PageUp', 'PageUp', 33, 0],
  };
  const pressToken = async (token) => {
    if (NAMED_KEYS[token]) await press(...NAMED_KEYS[token]);
    else if (/^C-[a-z]$/.test(token)) await press(token[2], `Key${token[2].toUpperCase()}`, token[2].toUpperCase().charCodeAt(0), 2);
    else await page('Input.insertText', { text: token });
    await sleep(150);
  };
  const walkStep = async (where, step) => {
    await waitUntil(`${where} の表示`, async () => (await currentStep()) === step.id);
    assert.equal(await evaluate(`document.querySelector('.tmux-highlights').childElementCount`), step.highlight ? 1 : 0, `${where}: ハイライトの数が違います`);
    if (step.check) assert.notEqual(await run(step.check), 0, `${where}: do の前から合格しています`);
    for (const [index, token] of (step.do ?? []).entries()) {
      await pressToken(token);
      if (step.check && index < step.do.length - 1) assert.notEqual(await run(step.check), 0, `${where}: do の途中（${token}）で合格しました`);
    }
    if (!step.check) await evaluate(`document.getElementById('next').click()`);
    await waitUntil(`${where} の合格`, async () => (await currentStep()) !== step.id);
    await sleep(550); // 矢印キーの repeat-time（500ms）が次の入力に影響しないようにする
  };
  const lessons = course.modules.flatMap((module) => module.lessons.map((lesson) => ({ ...lesson, where: `${module.id}/${lesson.id}` })));
  for (const [index, lesson] of lessons.entries()) {
    for (const step of lesson.steps) await walkStep(`${lesson.where}/${step.id}`, step);
    if (index < lessons.length - 1) await evaluate(`document.getElementById('next-lesson').click()`);
  }
  assert.equal(await evaluate(`document.getElementById('status').textContent`), 'すべてのレッスンを完了しました。');
  assert.ok(await evaluate(`document.getElementById('next-lesson').hidden`));

  // 前のレッスンの状態が残っていても、最初のステップが合格して飛ばされない
  const selectLesson = (where) => evaluate(`(() => { const select = document.getElementById('lessons'); select.value = '#${where}'; select.dispatchEvent(new Event('change')); })()`);
  for (const lesson of lessons.slice(0, -1).toReversed()) {
    await selectLesson(lesson.where);
    await waitUntil(`${lesson.where} の表示`, async () => (await currentStep()) === lesson.steps[0].id);
    await sleep(600);
    assert.equal(await currentStep(), lesson.steps[0].id, `${lesson.where}: 最初のステップが飛ばされました`);
  }

  // デタッチ中にレッスンを移ると、端末を戻せないので VM を作り直してから始める
  const second = lessons[1];
  await run('tmux detach-client');
  await waitUntil('デタッチ', async () => (await run('[ -z "$(tmux list-clients)" ]')) === 0);
  await evaluate(`window.beforeReload = true`);
  await selectLesson(second.where);
  await waitUntil(
    'VM の作り直し',
    async () => (await evaluate(`window.beforeReload`).catch(() => true)) === undefined && (await currentStep().catch(() => null)) === second.steps[0].id,
    60_000,
  );
  await reloadedTerminal();
  assert.equal(await run('[ -n "$(tmux list-clients)" ]'), 0, '作り直した VM で tmux に接続されていません');
  assert.equal(await evaluate(`location.hash`), `#${second.where}`, '再読み込みでレッスンの位置が変わりました');

  // 環境が止まっている間は画面に表示し、動き出すと消える
  const polling = lessons.find((lesson) => lesson.steps[0].check);
  const status = () => evaluate(`document.getElementById('status').textContent`);
  await selectLesson(polling.where);
  await waitUntil(`${polling.where} の表示`, async () => (await currentStep()) === polling.steps[0].id);
  assert.equal(await status(), '');
  await run('tmux kill-server');
  await waitUntil('環境の停止の表示', async () => (await status()).includes('やり直す'));
  await run('tmux new -d -s lesson');
  await waitUntil('環境の復帰の表示', async () => (await status()) === '');

  assert.deepEqual(problems, [], 'コンソールにエラーがあります（CSP 違反を含む）');
  const external = requested.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith('blob:') && !url.startsWith('data:'));
  assert.deepEqual(external, [], '同一オリジン以外への通信があります');
  console.log(`OK: ${requested.length} リクエスト、すべて同一オリジン`);
} finally {
  chrome.kill();
  server.kill();
}
process.exit(0);
