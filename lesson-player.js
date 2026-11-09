// シナリオを読み込み、<tmux-terminal> の上でレッスンを進める。シナリオの形は courses/linux/index.js を参照。
//
// VM の作り直しはページの再読み込みに任せる。レッスンの位置は URL のハッシュに持つので、再読み込みしても同じレッスンに戻る。
// 進捗は保存しない（VM の状態が残らないので、途中のステップには戻れない）。

import './tmux-terminal.js';
import course from './courses/linux/index.js';

const POLL_INTERVAL = 300;
const KEY_LABELS = { Left: '←', Right: '→', Up: '↑', Down: '↓' };
const ENV_STOPPED = 99; // course.alive が失敗したときの check の終了コード
const ENV_STOPPED_MESSAGE = '環境が止まっています。「このレッスンをやり直す」を押してください。';
const STEP_MOVE = { duration: 500, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };

const $ = (id) => document.getElementById(id);
const terminal = document.querySelector('tmux-terminal');
const hashOf = (module, lesson) => `#${module.id}/${lesson.id}`;
const lessons = course.modules.flatMap((module) => module.lessons.map((lesson) => ({ ...lesson, hash: hashOf(module, lesson) })));
const vmStarted = new Promise((resolve) => terminal.addEventListener('tmux-layout', resolve, { once: true }));

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
    item.append(folded('答えを見る', ...step.do.flatMap((token) => [code(label(token)), ' '])));
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
    const pane = terminal.layout?.panes.find((p) => p.active);
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

// check を繰り返し実行する。環境が動いているかも同じコマンドで確かめ、止まっている間は画面に表示する。
// reject は VM が応答しないときで、lesson-agent が再起動すれば次の回に直る
async function passed(check, stale) {
  const command = course.alive ? `${course.alive} || exit ${ENV_STOPPED}; ${check}` : check;
  while (!stale()) {
    const code = await terminal.run(command).catch(() => null);
    if (stale()) return;
    $('status').textContent = code === null || code === ENV_STOPPED ? ENV_STOPPED_MESSAGE : '';
    if (code === 0) return;
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

  await vmStarted;
  if (stale()) return;
  const setup = [course.setup, lesson.setup].filter(Boolean).join(' && ');
  const setupCode = setup ? await terminal.run(setup).catch(() => null) : 0;
  if (stale()) return;
  if (setupCode !== 0) {
    if (!vmIsFresh) return location.reload();
    console.error(`${lesson.hash} の setup が失敗しました: ${setupCode}`);
    $('status').textContent = 'レッスンを準備できませんでした。';
    return;
  }
  vmIsFresh = false;
  $('status').textContent = '';

  for (const [index, step] of lesson.steps.entries()) {
    setActiveStep(step);
    $('next').hidden = Boolean(step.check);
    const item = showStep(step);
    await (step.check ? passed(step.check, stale) : clicked($('next')));
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
for (const module of course.modules) {
  const group = document.createElement('optgroup');
  group.label = module.title;
  group.append(...module.lessons.map((lesson) => new Option(lesson.title, hashOf(module, lesson))));
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
      if (terminal.contains(document.activeElement)) ($('next').hidden ? $('lessons') : $('next')).focus();
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
    $('status').textContent = ENV_STOPPED_MESSAGE;
    if (document.fullscreenElement) document.exitFullscreen();
  });
  const minimize = win.querySelector('.minimize');
  minimize.addEventListener('click', () => minimize.setAttribute('aria-pressed', win.classList.toggle('minimized')));
}

maximizeTerminal.addEventListener('click', () => {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (terminalWindow.classList.contains('minimized')) minimizeTerminal.click();
  navigator.keyboard?.lock(['Escape']); // Esc をコピーモードで使えるようにする。対応ブラウザでは Esc の長押しで解除する
  document.documentElement.requestFullscreen();
});

const fitTerminal = () => (document.fullscreenElement ? terminal.fit(terminal.clientWidth, terminal.clientHeight) : terminal.fit());
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

play();
