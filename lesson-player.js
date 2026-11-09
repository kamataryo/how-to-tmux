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
  $('steps').append(item);
  $('steps').scrollTop = $('steps').scrollHeight;
  return item;
}

function markDone(item) {
  item.removeAttribute('aria-current');
  item.className = 'done';
  item.querySelectorAll('details').forEach((details) => details.remove());
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
$('steps').addEventListener('toggle', () => ($('steps').scrollTop = $('steps').scrollHeight), true);
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
    // このキーの配送先はもう決まっているので、端末へ送り直す。文字の入力は続く keypress が端末へ届く
    if (document.activeElement === document.body && !event.metaKey) {
      terminal.focus();
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', event));
    }
  },
  true,
);

play();
