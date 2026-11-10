// 配信物をヘッドレス Chrome で開き、本物の tmux が動くことと、CSP で壊れていないことを確かめる。
// 使い方: node vm/smoke.mjs [site のパス]（既定は dist/site）。ブラウザは環境変数 CHROME で変更できる

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STATE_FILE } from '../vm-config.js';

const site = process.argv[2] ?? 'dist/site';
const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8799;
const origin = `http://127.0.0.1:${PORT}`;
assert.ok(existsSync(path.join(site, 'images/state.bin.zst')), `${site} に配信物がありません。先に vm/build.sh を実行してください`);
const { default: course } = await import(path.resolve(site, 'course.mjs')); // 配信物のコース

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn('python3', ['-I', '-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', site], { stdio: 'ignore' });
const profile = mkdtempSync(path.join(tmpdir(), 'how-to-tmux-smoke-'));
const chrome = spawn(chromePath, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,900', '--screen-info={1440x900}', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

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
  const paused = []; // Fetch.enable で止めているリクエスト
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
    if (method === 'Fetch.requestPaused') paused.push(params.request.url);
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
  assert.equal(await evaluate(`tmux.ready`), true, 'レッスンが始まっているのに ready が false です');
  await waitUntil('setup で番号を振り直した後のウィンドウ番号', () => evaluate(`tmux.layout.window === 0`));

  // アイコンと OGP 画像が配信物にあり、CSP で読める
  for (const [file, width] of [['icon.png', 512], ['ogp.png', 1200]]) {
    const loaded = await evaluate(`new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image.naturalWidth); image.onerror = () => resolve(0); image.src = './${file}'; })`);
    assert.equal(loaded, width, `${file} を読めません`);
  }
  // ライセンスはダウンロードにならず、ブラウザで読める形式で配信される
  const license = await fetch(await evaluate(`document.getElementById('license').href`));
  assert.ok(license.ok && license.headers.get('content-type').startsWith('text/plain'), `ライセンスを読めません: ${license.status} ${license.headers.get('content-type')}`);

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

  // ライセンスのリンクは、プロンプトが見えていれば端末の less で開く。打ちかけの入力を消せないと less が動かず、表示されない。
  // 今は左右に分割した幅 49 のペインにいるので、fold が効いていれば次の語は行頭に来る（効いていないと ver で切れる）
  const paneRuns = async (command) => (await run(`[ "$(tmux display -p '#{pane_current_command}')" = ${command} ]`)) === 0;
  const clickLicense = () => evaluate(`window.opened = []; window.open = (url) => opened.push(url); document.getElementById('license').click()`);
  await page('Input.insertText', { text: 'half-typed' });
  await waitUntil('打ちかけの入力', async () => (await screen()).includes('half-typed'));
  await clickLicense();
  await waitUntil('端末でのライセンスの表示', async () => (await paneRuns('less')) && (await run(`tmux capture-pane -p | grep -qx 'verbatim copies'`)) === 0);
  assert.equal(await evaluate(`opened.length`), 0, 'プロンプトが見えているのに新しいタブを開きました');
  await run('tmux send-keys q');
  await waitUntil('less の終了', () => paneRuns('sh'));
  // 端末を最小化したまま開いても見えないので、元に戻す
  await evaluate(`document.querySelector('#terminal-window .minimize').click()`);
  await clickLicense();
  await waitUntil('最小化の解除', () => evaluate(`!document.getElementById('terminal-window').classList.contains('minimized')`));
  await waitUntil('最小化から戻した端末の less', () => paneRuns('less'));
  await run('tmux send-keys q');
  await waitUntil('less の終了', () => paneRuns('sh'));
  // コピーモードの最中はキーを送らず、新しいタブで開く
  await run('tmux copy-mode');
  await clickLicense();
  await waitUntil('コピーモード中のライセンスの表示', () => evaluate(`opened.length === 1`));
  assert.equal(await run(`[ "$(tmux display -p '#{pane_in_mode}')" = 1 ]`), 0, 'リンクを押すとコピーモードが終わりました');
  await run('tmux send-keys -X cancel');

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
    // 進行中のステップは欄の下端にある。手順が欄からはみ出す長さになっても同じ
    const gap = await evaluate(`Promise.allSettled(document.getElementById('steps').getAnimations({ subtree: true }).map((animation) => animation.finished)).then(() => {
      const steps = document.getElementById('steps');
      return steps.getBoundingClientRect().bottom - steps.querySelector('[aria-current]').getBoundingClientRect().bottom;
    })`);
    assert.ok(Math.abs(gap) < 1, `${where}: 進行中のステップが下端にありません: ${gap}`);
    assert.equal(await evaluate(`document.querySelector('.terminal-highlights').childElementCount`), step.highlight ? 1 : 0, `${where}: ハイライトの数が違います`);
    if (step.figure) await waitUntil(`${where} の図`, () => evaluate(`document.querySelector('[aria-current="step"] .figure img')?.naturalWidth > 0`));
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

  // ステップを終えると、前の行は今の位置から動き出し、次の行は欄の下から透明な状態で現れる（最初のレッスンの最初のステップは「次へ」で進む）
  const stepMove = await evaluate(`(async () => {
    const steps = document.getElementById('steps');
    const doneTop = steps.firstElementChild.getBoundingClientRect().top;
    document.getElementById('next').click();
    await new Promise((resolve) => setTimeout(resolve));
    const moves = steps.getAnimations({ subtree: true }).filter((animation) => !(animation instanceof CSSTransition));
    moves.forEach((animation) => { animation.pause(); animation.currentTime = 0; });
    const [done, next] = steps.children;
    const start = { moves: moves.length, doneMoved: done.getBoundingClientRect().top - doneTop, nextBelow: next.getBoundingClientRect().top - steps.getBoundingClientRect().bottom, nextOpacity: getComputedStyle(next).opacity };
    moves.forEach((animation) => animation.finish());
    return start;
  })()`);
  assert.equal(stepMove.moves, 2, 'ステップの行が動いていません');
  assert.ok(Math.abs(stepMove.doneMoved) < 1, `終えたステップが動き出す前に飛びました: ${stepMove.doneMoved}`);
  assert.ok(Math.abs(stepMove.nextBelow) < 1, `次のステップが欄の下から現れません: ${stepMove.nextBelow}`);
  assert.equal(stepMove.nextOpacity, '0');

  // 先に次のステップの状態になっていても、読む前に進まない。
  // 上下に分けてから左右に分けると「左右に分ける」は合格し、次の「上下に分ける」は操作する前から合格している
  const [, splitRight, splitDown, afterSplit] = lessons[0].steps;
  assert.equal(await currentStep(), splitRight.id);
  await run('tmux split-window -v');
  for (const token of splitRight.do) await pressToken(token);
  await waitUntil('先に合格していたステップの「次へ」', async () => (await currentStep()) === splitDown.id && (await evaluate(`!document.getElementById('next').hidden`)));
  await sleep(600);
  assert.equal(await currentStep(), splitDown.id, '先に合格していたステップが飛ばされました');
  assert.ok((await evaluate(`document.getElementById('status').textContent`)).includes('次へ'));
  await evaluate(`document.getElementById('next').click()`);
  await waitUntil('「次へ」で進む', async () => (await currentStep()) === afterSplit.id);
  assert.equal(await evaluate(`document.getElementById('status').textContent`), '');

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

  // ウィンドウの枠。フルスクリーンにはユーザー操作が要るので、本物のマウス操作で押す
  const rectOf = (selector) => evaluate(`(() => { const { left, top, width, height } = document.querySelector('${selector}').getBoundingClientRect(); return { left, top, width, height }; })()`);
  const mouse = (type, x, y, buttons = 1) => page('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  const clickOn = async (selector) => {
    const { left, top, width, height } = await rectOf(selector);
    const [x, y] = [left + width / 2, top + height / 2];
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y, 0);
  };
  const terminalWindow = '#terminal-window';
  const fontSize = () => evaluate(`parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize)`);
  const screenSize = () => rectOf('.xterm-screen');

  // 通常時は端末が左、欄が右で、どちらも上下の中央にある
  const [terminalRect, lessonRect, viewportHeight] = [await rectOf(terminalWindow), await rectOf('#lesson'), await evaluate(`innerHeight`)];
  assert.ok(terminalRect.left + terminalRect.width <= lessonRect.left, '端末が欄の左にありません');
  for (const { top, height } of [terminalRect, lessonRect]) assert.ok(Math.abs(top + height / 2 - viewportHeight / 2) < 1, '上下の中央にありません');

  // 最小化しても VM は動き続け、最小化中のキー入力でエラーにならない
  const normalSize = await screenSize();
  await clickOn(`${terminalWindow} .minimize`);
  assert.equal((await rectOf(terminalWindow)).height, (await rectOf(`${terminalWindow} .titlebar`)).height + 2, '最小化できません');
  await evaluate(`document.activeElement.blur()`); // 余白をクリックした後と同じ。フォーカスを戻せないときにキー入力の転送が再帰しない
  await press('a', 'KeyA', 65, 0, 'a');
  await clickOn(`${terminalWindow} .minimize`);
  const restoredSize = await screenSize();
  assert.deepEqual([restoredSize.width, restoredSize.height], [normalSize.width, normalSize.height], '最小化から戻すと大きさが変わりました');
  assert.ok(await evaluate(`tmux.contains(document.activeElement)`), '最小化から戻すと端末にフォーカスがありません');
  assert.equal(await run('true'), 0);

  // フルスクリーンでは文字の大きさはそのままで、桁数と行数が画面いっぱいに増える。VM の端末も同じ大きさになる。欄は常に前面でドラッグできる
  const gridSize = () => evaluate(`({ cols: tmux.cols, rows: tmux.rows })`);
  // この時点では tmux を作り直していて端末は接続していないので、端末そのものの大きさを見る
  const clientIs = async ({ cols, rows }) => (await run(`[ "$(stty -F /dev/ttyS0 size)" = '${rows} ${cols}' ]`)) === 0;
  const normalGrid = await gridSize();
  await clickOn(`${terminalWindow} .maximize`);
  await waitUntil('フルスクリーン', () => evaluate(`!!document.fullscreenElement`));
  await waitUntil('桁数と行数の拡大', async () => { const { cols, rows } = await gridSize(); return cols > normalGrid.cols && rows > normalGrid.rows; });
  const fullGrid = await gridSize();
  assert.equal(await fontSize(), 14, 'フルスクリーンで文字の大きさが変わりました');
  await waitUntil('VM の端末の大きさの拡大', () => clientIs(fullGrid));
  const { innerWidth, innerHeight } = await evaluate(`({ innerWidth, innerHeight })`);
  const titlebarHeight = (await rectOf(`${terminalWindow} .titlebar`)).height;
  const fitted = await screenSize();
  assert.ok(fitted.left >= 0 && fitted.left + fitted.width <= innerWidth && fitted.top >= titlebarHeight && fitted.top + fitted.height <= innerHeight, `文字盤が画面に収まっていません: ${JSON.stringify(fitted)}`);
  // あと 1 桁、1 行は入らないところまで埋まっている
  assert.ok(innerWidth - fitted.width < fitted.width / fullGrid.cols + 1 && innerHeight - titlebarHeight - fitted.height < fitted.height / fullGrid.rows + 1, `文字盤が画面を埋めていません: ${JSON.stringify(fitted)}`);
  assert.equal(await evaluate(`document.querySelectorAll('.xterm-rows > div').length`), fullGrid.rows);
  assert.ok(await evaluate(`document.querySelector('${terminalWindow} .minimize').disabled`), 'フルスクリーン中は最小化できません');
  const inFront = () => evaluate(`(() => { const { left, top, width, height } = document.getElementById('lesson').getBoundingClientRect(); return !!document.elementFromPoint(left + width / 2, top + height / 2).closest('#lesson'); })()`);
  assert.ok(await inFront(), '欄が端末の前面にありません');
  const dragBar = async (dx, dy) => {
    const { left, top, width } = await rectOf('#lesson .titlebar');
    const [x, y] = [left + width / 2, top + 16];
    await mouse('mousePressed', x, y);
    await mouse('mouseMoved', x + dx, y + dy);
    await mouse('mouseReleased', x + dx, y + dy, 0);
  };
  const lessonBefore = await rectOf('#lesson');
  await dragBar(-120, -40);
  const moved = await rectOf('#lesson');
  assert.ok(Math.abs(moved.left - (lessonBefore.left - 120)) < 1 && Math.abs(moved.top - Math.max(0, lessonBefore.top - 40)) < 1, `ドラッグで動きません: ${JSON.stringify(moved)}`);
  assert.ok(await inFront(), 'ドラッグの後に欄が前面にありません');
  await dragBar(-5000, -5000);
  const clamped = await rectOf('#lesson');
  assert.deepEqual([clamped.left, clamped.top], [0, 0], '画面の外へ出ました');

  // 緑でもう一度押すと元に戻る（左上へ動かした欄が緑のボタンに重なっているので、先にどかす）
  await dragBar(400, 100);
  await clickOn(`${terminalWindow} .maximize`);
  await waitUntil('フルスクリーンの解除', () => evaluate(`!document.fullscreenElement`));
  await waitUntil('桁数と行数の復帰', async () => JSON.stringify(await gridSize()) === JSON.stringify(normalGrid));
  await waitUntil('VM の端末の大きさの復帰', () => clientIs(normalGrid));
  assert.equal(await fontSize(), 14);
  const lessonRestored = await rectOf('#lesson');
  assert.deepEqual([lessonRestored.left, lessonRestored.top], [lessonRect.left, lessonRect.top], 'ドラッグした位置が残っています');

  // 欄を消してもレッスンは進み続ける
  await clickOn('#lesson .minimize');
  assert.equal((await rectOf('#lesson')).height, (await rectOf('#lesson .titlebar')).height + 2, '欄を最小化できません');
  await clickOn('#lesson .minimize');
  await clickOn('#lesson .close');
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('lesson')).display`), 'none');
  assert.equal(await run('true'), 0);

  // 端末を消すと VM も止まり、キー入力やクリックでエラーにならない
  const busyRatio = async () => {
    const taskDuration = async () => (await page('Performance.getMetrics')).metrics.find(({ name }) => name === 'TaskDuration').value;
    const [startedTask, startedAt] = [await taskDuration(), performance.now()];
    await sleep(2000);
    return (await taskDuration() - startedTask) / ((performance.now() - startedAt) / 1000);
  };
  await page('Performance.enable');
  const busyBefore = await busyRatio();
  await clickOn(`${terminalWindow} .close`);
  assert.equal(await evaluate(`!!document.querySelector('tmux-terminal')`), false);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('terminal-window')).display`), 'none');
  assert.ok((await status()).includes('やり直す'));
  await clickLicense();
  await waitUntil('端末を消した後のライセンスの表示', () => evaluate(`opened.length === 1`));
  await evaluate(`document.activeElement.blur()`); // 余白をクリックした後と同じ。フォーカスを戻せないときにキー入力の転送が再帰しない
  await press('a', 'KeyA', 65, 0, 'a');
  await evaluate(`document.body.click()`);
  const busyAfter = await busyRatio();
  assert.ok(busyAfter < busyBefore / 2, `端末を消しても VM が止まっていません: ${busyBefore} → ${busyAfter}`);

  // 読み込み中に消しても例外にならず、読み込み後に VM が動き出さない
  // 進捗バーが見えている時間は短く、ポーリングでは捉えられないことがあるので、状態ファイルの転送を止めておく
  await page('Fetch.enable', { patterns: [{ urlPattern: `*/${STATE_FILE}` }] });
  await page('Page.reload');
  await waitUntil('状態ファイルの転送の開始', () => paused.length > 0);
  await waitUntil('読み込みの開始', () => evaluate(`!!document.querySelector('tmux-terminal progress')`).catch(() => false));
  await clickOn(`${terminalWindow} .close`);
  await page('Fetch.disable'); // 止めていた転送はここから進む
  await sleep(8000); // 状態ファイルの読み込みと起動が終わるのを待つ
  const busyLoaded = await busyRatio();
  assert.ok(busyLoaded < busyBefore / 2, `読み込み中に消しても VM が動き出しました: ${busyBefore} → ${busyLoaded}`);

  assert.deepEqual(problems, [], 'コンソールにエラーがあります（CSP 違反を含む）');
  const external = requested.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith('blob:') && !url.startsWith('data:'));
  assert.deepEqual(external, [], '同一オリジン以外への通信があります');
  console.log(`OK: ${requested.length} リクエスト、すべて同一オリジン`);
} finally {
  chrome.kill();
  server.kill();
}
process.exit(0);
