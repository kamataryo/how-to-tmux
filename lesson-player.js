// シナリオを読み込み、端末の上でレッスンを進める。シナリオの形は courses/linux/index.js を参照。
// どのコースを進めるかはビルドで決まる（vm/build.sh が course.mjs を作る）。端末の要素もコースが選ぶ。
//
// VM の作り直しはページの再読み込みに任せる。レッスンの位置は URL のハッシュに持つので、再読み込みしても同じレッスンに戻る。
// 進捗は保存しない（VM の状態が残らないので、途中のステップには戻れない）。

import course from './course.mjs';

const POLL_INTERVAL = 300;
const KEY_LABELS = { Left: '←', Right: '→', Up: '↑', Down: '↓' };
const ENV_STOPPED = 99; // course.alive が失敗したときの check の終了コード
const ENV_STOPPED_MESSAGE = '環境が止まっています。「このレッスンをやり直す」を押してください。';
const TERMINAL_CLOSED_MESSAGE = '端末を閉じました。「このレッスンをやり直す」を押してください。';
const ALREADY_PASSED_MESSAGE = 'すでにこの状態になっています。操作を試したら「次へ」を押してください。';
const HINT_DELAY = 30_000; // この間進まなければ、ヒントを開いて見せる
const STEP_MOVE = { duration: 500, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };

const $ = (id) => document.getElementById(id);

// 端末はコースが選んだ要素（<vm-terminal> か、それを拡張したもの）で、要素名と同じ名前のファイルが定義する
const terminalTag = course.terminal ?? 'vm-terminal';
await import(`./${terminalTag}.js`);
const terminal = Object.assign(document.createElement(terminalTag), { id: 'terminal' });
$('terminal-window').append(terminal);

const hashOf = (module, lesson) => `#${module.id}/${lesson.id}`;
const lessons = course.modules.flatMap((module) => module.lessons.map((lesson) => ({ ...lesson, hash: hashOf(module, lesson) })));
const vmReady = new Promise((resolve) => terminal.addEventListener('vm-ready', resolve, { once: true }));

const code = (text) => {
  const element = document.createElement('code');
  element.textContent = text;
  return element;
};

// `…` の部分をコードとして表示する。シナリオの文字列を HTML としては扱わない
const inline = (text) => text.split('`').map((part, index) => (index % 2 ? code(part) : part));

function folded(label, ...content) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  details.append(summary, ...content);
  return details;
}

const pinSteps = () => ($('steps').scrollTop = $('steps').scrollHeight);

// 手順の欄を変更し、各行を今見えている位置から新しい位置へなめらかに動かす（FLIP）。新しい行は欄の下から現れる。
// 動いている途中の位置から始めるので、続けて呼んでも 1 つの動きにつながる
function moveSteps(change) {
  const steps = $('steps');
  const before = new Map([...steps.children].map((item) => [item, item.getBoundingClientRect().top]));
  steps.getAnimations({ subtree: true }).forEach((animation) => animation instanceof CSSTransition || animation.cancel()); // 行の色の変化は残す
  change();
  pinSteps();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const { bottom } = steps.getBoundingClientRect();
  for (const item of steps.children) {
    const from = (before.get(item) ?? bottom) - item.getBoundingClientRect().top;
    item.animate({ translate: [`0 ${from}px`, '0 0'], opacity: [before.has(item) ? 1 : 0, 1] }, STEP_MOVE);
  }
}

function showStep(step) {
  const item = document.createElement('li');
  item.dataset.step = step.id;
  item.setAttribute('aria-current', 'step');
  const say = document.createElement('p');
  say.append(...inline(step.say));
  item.append(say);
  if (step.hint) item.append(folded('ヒント', ...inline(step.hint)));
  if (step.do) {
    const label = (token) => KEY_LABELS[token] ?? token.replace(/^C-/, 'Ctrl-');
    // 長い手順でも区切りがわかるよう、Enter のあとで改行する
    const breakAfter = (token, index) => (token === 'Enter' && index < step.do.length - 1 ? document.createElement('br') : ' ');
    item.append(folded('答えを見る', ...step.do.flatMap((token, index) => [code(label(token)), breakAfter(token, index)])));
  }
  moveSteps(() => $('steps').append(item));
  return item;
}

function markDone(item) {
  moveSteps(() => {
    item.removeAttribute('aria-current');
    item.className = 'done';
    item.querySelectorAll('details').forEach((details) => details.remove());
  });
}

let activeStep = null;
let box = null;

function drawHighlight() {
  box?.remove();
  box = null;
  const target = activeStep?.highlight;
  if (target === 'active-pane') {
    const pane = terminal.layout?.panes.find((p) => p.active); // layout があるのは <tmux-terminal> だけ
    if (pane) box = terminal.highlight(pane.col, pane.row, pane.width, pane.height);
  } else if (target) {
    box = terminal.highlight(...target);
  }
}

function setActiveStep(step) {
  activeStep = step;
  drawHighlight();
}

const clicked = (button) => new Promise((resolve) => button.addEventListener('click', resolve, { once: true }));

let stoppedMessage = ENV_STOPPED_MESSAGE;

// check を繰り返し実行する。環境が動いているかも同じコマンドで確かめ、止まっている間は画面に表示する。
// reject は VM が応答しないときで、lesson-agent が再起動すれば次の回に直る。
// 一度も不合格にならずに合格したときは、前の操作で先にその状態になっている。
// そのまま進めると指示を読む前に次へ移ってしまうので、「次へ」で進めてもらう
async function passed(check, stale) {
  const command = course.alive ? `${course.alive} || exit ${ENV_STOPPED}; ${check}` : check;
  let failedOnce = false;
  while (!stale()) {
    const code = await terminal.run(command).catch(() => null);
    if (stale()) return;
    $('status').textContent = code === null || code === ENV_STOPPED ? stoppedMessage : '';
    if (code === 0) {
      if (failedOnce) return;
      $('status').textContent = ALREADY_PASSED_MESSAGE;
      $('next').hidden = false;
      await clicked($('next'));
      if (!stale()) $('status').textContent = '';
      return;
    }
    if (code !== null && code !== ENV_STOPPED) failedOnce = true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

let playing = 0; // レッスンを移ると増え、前のレッスンの進行が止まる
let vmIsFresh = true; // 作り直した直後の VM で setup が失敗したら、再読み込みしても直らない

async function play() {
  const current = ++playing;
  const stale = () => current !== playing;
  const lesson = lessons.find(({ hash }) => hash === location.hash) ?? lessons[0];

  setActiveStep(null);
  $('lessons').value = lesson.hash;
  $('goal').textContent = lesson.goal;
  $('steps').replaceChildren();
  $('progress').max = lesson.steps.length;
  $('progress').value = 0;
  $('next').hidden = true;
  $('next-lesson').hidden = true;
  $('status').textContent = '準備中…';

  terminal.classList.add('preparing');
  await vmReady;
  if (stale()) return;
  const setup = [course.setup, lesson.setup].filter(Boolean).join(' && ');
  const setupCode = setup ? await terminal.run(setup).catch(() => null) : 0;
  if (stale()) return;
  if (setupCode !== 0) {
    if (!vmIsFresh) return location.reload();
    console.error(`${lesson.hash} の setup が失敗しました: ${setupCode}`);
    $('status').textContent = 'レッスンを準備できませんでした。';
    terminal.classList.remove('preparing');
    return;
  }
  vmIsFresh = false;
  terminal.classList.remove('preparing');
  $('status').textContent = '';

  for (const [index, step] of lesson.steps.entries()) {
    setActiveStep(step);
    $('next').hidden = Boolean(step.check);
    const item = showStep(step);
    // details の 1 つ目がヒント。合格すると markDone() が details ごと消す
    const nudge = step.hint && step.check && setTimeout(() => item.querySelector('details')?.setAttribute('open', ''), HINT_DELAY);
    await (step.check ? passed(step.check, stale) : clicked($('next')));
    clearTimeout(nudge);
    if (stale()) return;
    markDone(item);
    $('progress').value = index + 1;
  }

  setActiveStep(null);
  $('next').hidden = true;
  const next = lessons[lessons.indexOf(lesson) + 1];
  $('status').textContent = next ? 'レッスン完了です。' : 'すべてのレッスンを完了しました。';
  if (next) {
    $('next-lesson').href = next.hash;
    $('next-lesson').hidden = false;
  }
}

document.title = course.title;
$('course-title').textContent = course.title;
let lessonNumber = 0; // 全体のどこにいるかがわかるよう、通し番号を付ける
for (const module of course.modules) {
  const group = document.createElement('optgroup');
  group.label = module.title;
  group.append(...module.lessons.map((lesson) => new Option(`${++lessonNumber}. ${lesson.title}`, hashOf(module, lesson))));
  $('lessons').append(group);
}

terminal.addEventListener('tmux-layout', drawHighlight);
addEventListener('hashchange', play);
$('restart').addEventListener('click', () => location.reload());
// toggle は泡立たないので capture で受ける。開いたヒントが欄の外に隠れないようにする
$('steps').addEventListener('toggle', pinSteps, true);
new ResizeObserver(pinSteps).observe($('steps')); // 欄の高さが変わっても、進行中のステップを下端に保つ
$('lessons').addEventListener('change', (event) => {
  location.hash = event.target.value;
  terminal.focus();
});

// 操作のあとはキー入力を端末へ戻す。文字を選んでいるときと、メニューを開くときは除く
addEventListener('click', (event) => {
  if (!event.target.closest('select') && getSelection().isCollapsed) terminal.focus();
});

addEventListener(
  'keydown',
  (event) => {
    // 端末は Tab キーも受け取るので、キーボードだけで欄へ移れるようにする
    if (event.key === 'F6') {
      event.preventDefault();
      event.stopPropagation();
      if (terminal.contains(document.activeElement)) ([$('next'), $('next-lesson')].find((element) => !element.hidden) ?? $('lessons')).focus();
      else terminal.focus();
      return;
    }
    // 文字の選択などでどこにもフォーカスがないと、キー入力が消えてしまう。Cmd は選んだ文字のコピーなどに残す。
    // このキーの配送先はもう決まっているので、端末へ送り直す。文字の入力は続く keypress が端末へ届く。
    // 端末を最小化したり消したりしているとフォーカスは移らず、body へ送り直すとこの処理に戻ってきてしまう
    if (document.activeElement === document.body && !event.metaKey) {
      terminal.focus();
      if (document.activeElement !== document.body) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', event));
    }
  },
  true,
);

// ウィンドウの枠。赤は消す（再読み込みまで戻らない）、黄は最小化、緑はフルスクリーン
const lessonWindow = $('lesson');
const terminalWindow = $('terminal-window');
const minimizeTerminal = terminalWindow.querySelector('.minimize');
const maximizeTerminal = terminalWindow.querySelector('.maximize');

for (const win of [lessonWindow, terminalWindow]) {
  win.querySelector('.close').addEventListener('click', () => {
    win.hidden = true; // 欄の中身は $() で参照し続けるので、DOM からは外さない
    if (win !== terminalWindow) return;
    terminal.remove(); // VM も破棄される
    stoppedMessage = TERMINAL_CLOSED_MESSAGE;
    $('status').textContent = stoppedMessage;
    if (document.fullscreenElement) document.exitFullscreen();
  });
  const minimize = win.querySelector('.minimize');
  minimize.addEventListener('click', () => {
    minimize.setAttribute('aria-pressed', win.classList.toggle('minimized'));
    fitTerminal();
  });
}

maximizeTerminal.addEventListener('click', () => {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (terminalWindow.classList.contains('minimized')) minimizeTerminal.click();
  navigator.keyboard?.lock(['Escape']); // Esc をコピーモードで使えるようにする。対応ブラウザでは Esc の長押しで解除する
  document.documentElement.requestFullscreen();
});

// ライセンスは端末の less で開く。できないときは新しいタブで開く（VM の起動前や端末を消した後は run() が reject する）
$('license').addEventListener('click', async (event) => {
  event.preventDefault();
  if (terminalWindow.classList.contains('minimized')) minimizeTerminal.click();
  const code = course.license ? await terminal.run(course.license).catch(() => null) : null;
  if (code !== 0) open($('license').href);
});

// フルスクリーンでは画面いっぱいにする。ふだんは元の大きさで、画面に収まらないときだけ文字を小さくして収める
function fitTerminal() {
  if (document.fullscreenElement) return terminal.fit(terminal.clientWidth, terminal.clientHeight);
  terminal.fit();
  if (!terminal.isConnected || terminalWindow.classList.contains('minimized')) return;
  const tooTall = document.documentElement.scrollHeight - innerHeight;
  const tooWide = terminal.scrollWidth - terminal.clientWidth;
  if (tooTall > 0 || tooWide > 0) terminal.fit(terminal.clientWidth, tooTall > 0 ? terminal.clientHeight - tooTall : Infinity);
}
addEventListener('resize', fitTerminal);
document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement);
  maximizeTerminal.setAttribute('aria-pressed', on);
  minimizeTerminal.disabled = on;
  if (!on) lessonWindow.removeAttribute('style'); // ドラッグした位置を捨てて元の場所へ戻す
  fitTerminal();
});

// フルスクリーンの間だけ、欄をタイトルバーでドラッグできる。タイトルバーが画面の外へ出ないよう、画面内に収める
const lessonBar = lessonWindow.querySelector('.titlebar');
let grab;
lessonBar.addEventListener('pointerdown', (event) => {
  if (!document.fullscreenElement || event.target.closest('button')) return;
  const { left, top } = lessonWindow.getBoundingClientRect();
  grab = { x: event.clientX - left, y: event.clientY - top };
  lessonBar.setPointerCapture(event.pointerId);
});
lessonBar.addEventListener('pointermove', (event) => {
  if (!lessonBar.hasPointerCapture(event.pointerId)) return;
  const within = (value, max) => `${Math.max(0, Math.min(value, max))}px`;
  Object.assign(lessonWindow.style, {
    left: within(event.clientX - grab.x, innerWidth - lessonWindow.offsetWidth),
    top: within(event.clientY - grab.y, innerHeight - lessonWindow.offsetHeight),
    right: 'auto',
    translate: 'none',
  });
});

fitTerminal();
for (const win of [terminalWindow, lessonWindow]) win.classList.add('open'); // 中身の配置が決まったので見せる
play();
