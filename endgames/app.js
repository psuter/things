let cards = [];
let offset = 0;
let visible = [];
let shuffledIds = null;
const completed = new Set();
const $ = id => document.getElementById(id);
const names = {K:'king', Q:'queen', R:'rook', B:'bishop', N:'knight', P:'pawn'};
const describe = s => [...s].map(p => names[p]).join(' + ');
const numberOf = c => String(cards.indexOf(c) + 1).padStart(3, '0');
const chunks = (items, size) => Array.from({length: Math.ceil(items.length / size)}, (_, i) => items.slice(i * size, (i + 1) * size));

function mainlineText(card, limit = $('line-length').value) {
  if (!card.mainline?.length) return `Main line not cached yet. First move: ${card.bestMove}`;
  const moves = limit === 'all' ? card.mainline : card.mainline.slice(0, Number(limit));
  const text = moves.map((move, index) => {
    const prefix = move.turn === 'White' ? `${move.number}. ` : index === 0 ? `${move.number}… ` : '';
    return prefix + move.san;
  }).join(' ');
  return text + (moves.length < card.mainline.length || !card.mainlineComplete ? ' …' : ` ${card.mainlineResult}`) + (card.mainlineSource === 'tablebase' ? ' †' : '');
}

async function load() {
  const response = await fetch('./positions.json');
  if (!response.ok) throw new Error('The problem collection could not be loaded. Please reload the page.');
  cards = (await response.json()).cards;
  const selected = $('material').value;
  $('material').replaceChildren(new Option('All matchups', ''));
  [...new Set(cards.map(c => c.family))].sort().forEach(family => {
    $('material').add(new Option(family.split(' vs ').map(describe).join(' vs '), family));
  });
  if ([...$('material').options].some(o => o.value === selected)) $('material').value = selected;
  $('total').textContent = cards.length;
  render();
}

function matching() {
  const excludedMate = Number($('exclude-mate').value);
  const filtered = cards.filter(c => !c.themes?.some(theme => {
    // mateIn5 means five OR MORE moves in Lichess, so only exact 1–4 tags qualify.
    const match = /^mateIn([1-4])$/.exec(theme);
    return match && Number(match[1]) <= excludedMate;
  }) && (!$('material').value || c.family === $('material').value) && (!$('count').value || c.pieces === Number($('count').value)));
  filtered.sort((a,b) => $('sort').value === 'material' ? a.family.localeCompare(b.family) : $('sort').value === 'rating' ? a.rating - b.rating : a.pieces - b.pieces);
  if (shuffledIds) {
    const order = new Map(shuffledIds.map((id, index) => [id, index]));
    filtered.sort((a,b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  }
  return filtered;
}

function cardElement(c, printing=false) {
  const article = document.createElement('article');
  article.className = 'card'; article.dataset.id = c.id;
  const top = document.createElement('div'); top.className = 'card-top';
  const number = document.createElement('span'); number.textContent = `NO. ${numberOf(c)}`;
  const turn = document.createElement('strong'); turn.className = c.turn.toLowerCase(); turn.setAttribute('aria-label', `${c.turn} to move`); turn.title = `${c.turn} to move`;
  turn.innerHTML = `<svg class="turn-marker" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.8" fill="${c.turn === 'White' ? '#fff' : '#111'}" stroke="#111" stroke-width="1.2"/></svg>`;
  top.append(number, turn);
  const board = document.createElement('div'); board.className = 'board';
  board.setAttribute('role','img'); board.setAttribute('aria-label',`${c.white} versus ${c.black}. ${c.turn} to move. FEN: ${c.fen}`);
  // Local python-chess SVG. Namespace references to avoid duplicate IDs across boards.
  const prefix = `${printing ? 'print' : 'screen'}-${c.id}-`;
  const svg = printing ? c.svg.replaceAll('#f5f1e6', '#ffffff').replaceAll('#a9b6a2', '#d6d6d6').replaceAll('#465342', '#111111') : c.svg;
  board.innerHTML = svg.replace(/id="([^"]+)"/g, (_, id) => `id="${prefix}${id}"`).replace(/((?:xlink:)?href)="#([^"]+)"/g, (_, attr, id) => `${attr}="#${prefix}${id}"`);
  const done = document.createElement('label'); done.className = 'done';
  if (printing) {
    const box = document.createElement('span'); box.className = 'tickbox'; done.append(box);
  } else {
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = completed.has(c.id);
    checkbox.setAttribute('aria-label', `Problem ${numberOf(c)} completed`);
    checkbox.onchange = () => checkbox.checked ? completed.add(c.id) : completed.delete(c.id);
    done.append(checkbox);
  }
  done.append('Done');
  article.append(top, board, done);
  if (!printing && $('teacher').checked) {
    const answer = document.createElement('div'); answer.className = 'answer';
    const result = document.createElement('strong'); result.textContent = `${c.winner} wins`;
    const line = document.createElement('p'); line.className = 'mainline'; line.textContent = mainlineText(c);
    const detail = document.createElement('p'); detail.textContent = `White: ${c.white} / Black: ${c.black} · ${c.pieces} pieces · Puzzle rating ${c.rating} · ${c.mainlineSource === 'tablebase' ? 'Tablebase line' : 'Lichess puzzle solution'}`;
    answer.append(result, line, detail);
    if (c.mainline?.length && $('line-length').value !== 'all' && c.mainline.length > Number($('line-length').value)) {
      const full = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Full available line';
      const continuation = document.createElement('p'); continuation.className = 'mainline'; continuation.textContent = mainlineText(c, 'all');
      full.append(summary, continuation); answer.append(full);
    }
    for (const [label,url] of [['Explore position',c.analysis],['Source game',c.game],['Original puzzle',c.puzzle]]) {
      const link = document.createElement('a'); link.textContent = label; link.href = url; link.target = '_blank'; link.rel = 'noopener'; answer.append(link);
    }
    article.append(answer);
  }
  return article;
}

function render() {
  const filtered = matching();
  const size = $('batch').value === 'all' ? Math.max(1, filtered.length) : Number($('batch').value);
  if (offset >= filtered.length) offset = 0;
  visible = filtered.slice(offset, offset + size);
  $('summary').textContent = `${filtered.length} matching / ${cards.length} cached · ${visible.length} in this practice set`;
  $('batch-label').textContent = visible.length ? `Problems ${offset + 1}–${offset + visible.length} of ${filtered.length}${shuffledIds ? ' · shuffled' : ''}` : 'No matching problems';
  $('previous').disabled = offset === 0;
  $('next').disabled = offset + size >= filtered.length;
  $('shuffle').disabled = !filtered.length;
  $('print').disabled = !visible.length;
  $('cards').replaceChildren(...visible.map(c => cardElement(c)));
  if (!visible.length) $('cards').textContent = 'No cards match these filters. Try changing the matchup, piece count, or mate filter.';
  preparePrint();
}

function printHeading(title, detail) {
  const heading = document.createElement('div'); heading.className = 'sheet-heading';
  const label = document.createElement('strong'); label.textContent = title;
  const subtitle = document.createElement('span'); subtitle.textContent = detail;
  heading.append(label, subtitle); return heading;
}

function preparePrint() {
  let rules = $('print-rules');
  if (!rules) { rules = document.createElement('style'); rules.id = 'print-rules'; document.head.append(rules); }
  const worksheet = $('layout').value === 'worksheet';
  rules.textContent = `@page { size: ${$('paper').value} ${worksheet ? 'landscape' : 'portrait'}; margin: 10mm; }`;
  const pages = $('print-pages'); pages.replaceChildren();
  const perPage = worksheet ? 18 : 6;
  const groups = chunks(visible, perPage);
  groups.forEach((group, index) => {
    const sheet = document.createElement('section'); sheet.className = `print-sheet ${worksheet ? 'worksheet' : 'large-cards'}`;
    sheet.append(printHeading('Little Endgames · Practice', `Sheet ${index + 1} of ${groups.length}     Name: ____________________`));
    const grid = document.createElement('div'); grid.className = 'print-grid';
    grid.append(...group.map(c => cardElement(c, true))); sheet.append(grid); pages.append(sheet);
  });
  // Each practice sheet has its own matching answer page, after all problems.
  groups.forEach((group, index) => {
    const sheet = document.createElement('section'); sheet.className = 'print-sheet answer-sheet';
    sheet.append(printHeading('Little Endgames · Answer sheet', `Answers for practice sheet ${index + 1} of ${groups.length}`));
    const note = document.createElement('p'); note.textContent = '† tablebase line · … line truncated or stops before mate';
    sheet.append(note);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const title of ['Problem', 'Winning side', 'Main line']) { const th = document.createElement('th'); th.textContent = title; head.append(th); }
    const body = table.createTBody();
    group.forEach(c => { const row = body.insertRow(); row.dataset.id = c.id; for (const text of [numberOf(c), c.winner, mainlineText(c)]) row.insertCell().textContent = text; });
    sheet.append(table); pages.append(sheet);
  });
}

for (const id of ['material','count','exclude-mate','sort','batch']) $(id).addEventListener('change', () => { offset = 0; shuffledIds = null; render(); });
$('teacher').addEventListener('change', render);
$('line-length').addEventListener('change', render);
for (const id of ['layout','paper']) $(id).addEventListener('change', () => { $('print').textContent = $('layout').value === 'worksheet' ? 'Print worksheet ↗' : 'Print cards ↗'; preparePrint(); });
$('previous').onclick = () => { offset = Math.max(0, offset - Number($('batch').value)); render(); };
$('next').onclick = () => { offset += Number($('batch').value); render(); };
$('shuffle').onclick = () => {
  const ids = matching().map(c => c.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  shuffledIds = ids; offset = 0; render();
};
$('print').onclick = () => { preparePrint(); window.print(); };
window.addEventListener('beforeprint', preparePrint);
load().catch(error => {
  $('summary').textContent = 'Collection unavailable';
  $('status').textContent = error.message;
});
