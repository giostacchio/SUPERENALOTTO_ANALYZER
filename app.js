'use strict';

const STORE = 'se_v31_archive';
const V5_MODEL = 'se_v5_model';
const V5_DIARY = 'se_v5_diary';
const BUDGET_STORE = 'se_v53_budget';
const MODEL_VERSION = 'V5.3';
const DEFAULT_BUDGET = 4;
const TICKET_COST = 1;

let draws = [];
let model = null;
let diary = [];
let monthlyBudget = DEFAULT_BUDGET;
let busy = false;

const months = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12
};

const CANDIDATES = [
  { name: 'Bilanciata', freq: 0.45, delay: 0.15, pair: 0.25, anti: 0.15 },
  { name: 'Frequenza soft', freq: 0.60, delay: 0.05, pair: 0.20, anti: 0.15 },
  { name: 'Coppie soft', freq: 0.30, delay: 0.10, pair: 0.45, anti: 0.15 },
  { name: 'Anti-folla', freq: 0.25, delay: 0.10, pair: 0.15, anti: 0.50 },
  { name: 'Neutra', freq: 0.25, delay: 0.25, pair: 0.25, anti: 0.25 }
];

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMoney(value) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2
  }).format(Number(value) || 0);
}

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function setUI(main, sub, pct, isBusy) {
  const message = isBusy ? '<span class="spinner" aria-hidden="true"></span>' + main : main;
  byId('mainStatus').innerHTML = message;
  byId('mainSub').textContent = sub || '';
  byId('mainBar').style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  busy = Boolean(isBusy);
  ['bUpdate', 'bAnalyze', 'bGenerate'].forEach(function (id) {
    byId(id).disabled = busy;
  });
}

function pause(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms == null ? 20 : ms);
  });
}

function dedupeDraws(items) {
  const unique = new Map();
  items.forEach(function (draw) {
    if (!draw || !draw.date || !Array.isArray(draw.nums) || draw.nums.length !== 6) return;
    const nums = draw.nums.map(Number).filter(function (n) {
      return Number.isInteger(n) && n >= 1 && n <= 90;
    });
    if (new Set(nums).size !== 6) return;
    unique.set(draw.date, {
      year: Number(draw.year) || Number(String(draw.date).slice(0, 4)),
      contest: Number(draw.contest) || 0,
      date: draw.date,
      nums: nums.sort(function (a, b) { return a - b; })
    });
  });
  return Array.from(unique.values()).sort(function (a, b) {
    return a.date.localeCompare(b.date);
  });
}

function safeParse(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function saveDraws() {
  localStorage.setItem(STORE, JSON.stringify(draws));
}

function saveDiary() {
  localStorage.setItem(V5_DIARY, JSON.stringify(diary));
}

function saveModel() {
  localStorage.setItem(V5_MODEL, JSON.stringify(model));
}

function saveBudget() {
  localStorage.setItem(BUDGET_STORE, JSON.stringify(monthlyBudget));
}

function load() {
  draws = dedupeDraws(safeParse(STORE, []));
  model = safeParse(V5_MODEL, null);
  diary = safeParse(V5_DIARY, []);
  if (!Array.isArray(diary)) diary = [];

  const storedBudget = Number(safeParse(BUDGET_STORE, DEFAULT_BUDGET));
  monthlyBudget = Number.isFinite(storedBudget)
    ? Math.min(100, Math.max(1, Math.round(storedBudget)))
    : DEFAULT_BUDGET;
  byId('monthlyBudget').value = monthlyBudget;

  migrateDiary();
  evaluatePending();
  render();
}

function migrateDiary() {
  let changed = false;
  diary.forEach(function (record) {
    if (!Object.prototype.hasOwnProperty.call(record, 'played')) {
      record.played = null;
      changed = true;
    }
    if (record.played === true && !Number.isFinite(Number(record.cost))) {
      record.cost = TICKET_COST;
      changed = true;
    }
    if (record.played !== true && Number(record.cost) !== 0) {
      record.cost = 0;
      changed = true;
    }
    if (record.resultDate && Number(record.hits) < 2 && record.played === true && record.returnAmount == null) {
      record.returnAmount = 0;
      changed = true;
    }
  });
  if (changed) saveDiary();
}

function italianDateToISO(value, year) {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-zàèéìòù0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = cleaned.match(/(\d{1,2})\s+([a-zàèéìòù]+)(?:\s+(\d{4}))?/);
  if (!match || !months[match[2]]) return '';
  return (match[3] || year) + '-' + String(months[match[2]]).padStart(2, '0') + '-' + String(match[1]).padStart(2, '0');
}

function parseComArchive(text, year) {
  const raw = text.split('\n').map(function (line) {
    return line.replace(/^#+\s*/, '').trim();
  }).filter(Boolean);
  const out = [];
  const datePattern = /(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})/i;

  for (let i = 0; i < raw.length; i += 1) {
    const dateMatch = raw[i].match(datePattern);
    if (!dateMatch || Number(dateMatch[3]) !== year) continue;

    const date = italianDateToISO(dateMatch[0], year);
    const nums = [];
    let contest = 0;

    for (let j = i + 1; j < Math.min(i + 35, raw.length); j += 1) {
      if (j > i + 1 && datePattern.test(raw[j])) break;
      const contestMatch = raw[j].match(/Concorso\s*(?:n\.?|Nº)?\s*(\d{1,3})/i);
      if (contestMatch) contest = Number(contestMatch[1]);
      if (/^\d{1,2}$/.test(raw[j]) && nums.length < 6) {
        const n = Number(raw[j]);
        if (n >= 1 && n <= 90 && !nums.includes(n)) nums.push(n);
      }
    }

    if (nums.length === 6) {
      out.push({ year: year, contest: contest, date: date, nums: nums.sort(function (a, b) { return a - b; }) });
    }
  }
  return dedupeDraws(out);
}

function parseNetArchive(text, year) {
  const lines = text.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\d{1,3})\/(\d{2})\s*\|\s*(.+?)\s*\|?$/);
    if (!match) continue;

    const date = italianDateToISO(match[3], year);
    const nums = [];
    for (let j = i + 1; j < Math.min(i + 28, lines.length); j += 1) {
      if (/^\d{1,3}\/\d{2}\s*\|/.test(lines[j])) break;
      const candidates = Array.from(lines[j].matchAll(/(?:^|\s)(\d{1,2})(?=\s|$)/g)).map(function (item) {
        return Number(item[1]);
      }).filter(function (n) {
        return n >= 1 && n <= 90;
      });
      candidates.forEach(function (n) {
        if (nums.length < 6 && !nums.includes(n)) nums.push(n);
      });
    }

    if (nums.length === 6 && date) {
      out.push({
        year: year,
        contest: Number(match[1]),
        date: date,
        nums: nums.sort(function (a, b) { return a - b; })
      });
    }
  }
  return dedupeDraws(out);
}

async function getText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.text();
}

async function fetchYear(year) {
  const sources = [
    {
      url: 'https://r.jina.ai/https://www.superenalotto.com/archivio/estrazioni-' + year,
      parser: parseComArchive
    },
    {
      url: 'https://r.jina.ai/https://www.superenalotto.net/estrazioni/' + year,
      parser: parseNetArchive
    }
  ];
  const errors = [];

  for (const source of sources) {
    try {
      const text = await getText(source.url);
      const parsed = source.parser(text, year);
      if (parsed.length >= 8) return parsed;
      errors.push('pochi dati: ' + parsed.length);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.join(' / '));
}

function coverage() {
  const currentYear = new Date().getFullYear();
  const byYear = {};
  draws.forEach(function (draw) {
    if (!byYear[draw.year]) byYear[draw.year] = [];
    byYear[draw.year].push(draw);
  });
  const missing = [];
  for (let year = 1997; year <= currentYear; year += 1) {
    if (!byYear[year] || byYear[year].length < 8) missing.push(year);
  }
  return { byYear: byYear, missing: missing };
}

async function updateArchive() {
  const currentYear = new Date().getFullYear();
  const currentCoverage = coverage();
  const merged = new Map(draws.map(function (draw) { return [draw.date, draw]; }));
  const targets = [];

  for (let year = 1997; year <= currentYear; year += 1) {
    if (!currentCoverage.byYear[year] || currentCoverage.byYear[year].length < 8 || year === currentYear) {
      targets.push(year);
    }
  }
  if (!targets.length) targets.push(currentYear);

  const failed = [];
  for (let i = 0; i < targets.length; i += 1) {
    const year = targets[i];
    setUI(
      'AGGIORNAMENTO ARCHIVIO…',
      'Anno ' + year + ' · ' + (i + 1) + '/' + targets.length,
      5 + Math.round(70 * i / targets.length),
      true
    );
    try {
      const fresh = await fetchYear(year);
      fresh.forEach(function (draw) { merged.set(draw.date, draw); });
    } catch (_error) {
      failed.push(year);
    }
    await pause(25);
  }

  draws = dedupeDraws(Array.from(merged.values()));
  saveDraws();
  evaluatePending();
  render();
  return failed;
}

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hashSeed(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sample6(rng) {
  const numbers = Array.from({ length: 90 }, function (_unused, index) { return index + 1; });
  for (let i = 0; i < 6; i += 1) {
    const j = i + Math.floor(rng() * (90 - i));
    const tmp = numbers[i];
    numbers[i] = numbers[j];
    numbers[j] = tmp;
  }
  return numbers.slice(0, 6).sort(function (a, b) { return a - b; });
}

function hits(ticket, extracted) {
  return ticket.filter(function (n) { return extracted.includes(n); }).length;
}

function buildStats(history) {
  const count = Array(91).fill(0);
  const last = Array(91).fill(-1);
  const pairs = Array.from({ length: 91 }, function () { return Array(91).fill(0); });

  history.forEach(function (draw, index) {
    draw.nums.forEach(function (n) {
      count[n] += 1;
      last[n] = index;
    });
    for (let x = 0; x < 6; x += 1) {
      for (let y = x + 1; y < 6; y += 1) {
        const a = draw.nums[x];
        const b = draw.nums[y];
        pairs[a][b] += 1;
        pairs[b][a] += 1;
      }
    }
  });
  return { total: history.length, count: count, last: last, pairs: pairs };
}

function scoreNumber(n, stats, selected, weights) {
  const expected = Math.max(1, stats.total * 6 / 90);
  const frequency = stats.count[n] / expected;
  const delay = stats.last[n] < 0 ? 1 : Math.min(2, (stats.total - 1 - stats.last[n]) / 15);
  let pair = 1;
  if (selected.length) {
    pair = 1 + selected.reduce(function (sum, selectedNumber) {
      return sum + stats.pairs[n][selectedNumber];
    }, 0) / selected.length / 8;
  }
  const antiCrowd = n <= 31 ? 0.55 : 1.15;
  return Math.max(
    0.03,
    weights.freq * frequency + weights.delay * delay + weights.pair * pair + weights.anti * antiCrowd
  );
}

function weightedTicket(history, weights, rng) {
  const stats = buildStats(history);
  const selected = [];
  while (selected.length < 6) {
    const pool = [];
    let total = 0;
    for (let n = 1; n <= 90; n += 1) {
      if (selected.includes(n)) continue;
      const score = scoreNumber(n, stats, selected, weights);
      pool.push([n, score]);
      total += score;
    }
    let cursor = rng() * total;
    let pick = pool[pool.length - 1][0];
    for (const item of pool) {
      cursor -= item[1];
      if (cursor <= 0) {
        pick = item[0];
        break;
      }
    }
    selected.push(pick);
  }
  return selected.sort(function (a, b) { return a - b; });
}

function metric(distribution) {
  return distribution[2] + distribution[3] * 8 + distribution[4] * 80 + distribution[5] * 1200 + distribution[6] * 20000;
}

function sumFrom(distribution, start) {
  return distribution.slice(start).reduce(function (sum, value) { return sum + value; }, 0);
}

function evaluateWindow(start, end, weights, seedLabel) {
  const distribution = Array(7).fill(0);
  for (let index = start; index < end; index += 1) {
    const history = draws.slice(Math.max(0, index - 800), index);
    const rng = mulberry32(hashSeed(index + '-' + seedLabel));
    const ticket = weights ? weightedTicket(history, weights, rng) : sample6(rng);
    distribution[hits(ticket, draws[index].nums)] += 1;
  }
  return distribution;
}

async function analyzeV53() {
  if (draws.length < 900) {
    throw new Error('Archivio insufficiente: ' + draws.length + ' estrazioni. Aggiornalo prima.');
  }

  const holdoutN = Math.min(180, Math.max(90, Math.floor(draws.length * 0.05)));
  const validationN = Math.min(320, Math.max(150, Math.floor(draws.length * 0.08)));
  const holdoutStart = draws.length - holdoutN;
  const validationStart = holdoutStart - validationN;
  const validationResults = [];

  for (let candidateIndex = 0; candidateIndex < CANDIDATES.length; candidateIndex += 1) {
    const weights = CANDIDATES[candidateIndex];
    const distribution = Array(7).fill(0);

    for (let index = validationStart; index < holdoutStart; index += 1) {
      const history = draws.slice(Math.max(0, index - 800), index);
      const rng = mulberry32(hashSeed(index + '-' + candidateIndex + '-validation-v53'));
      const ticket = weightedTicket(history, weights, rng);
      distribution[hits(ticket, draws[index].nums)] += 1;

      if ((index - validationStart) % 35 === 0) {
        const partial = candidateIndex + (index - validationStart) / validationN;
        setUI(
          'ANALISI V5.3 IN CORSO…',
          'Validazione · ' + weights.name + ' · ' + (index - validationStart + 1) + '/' + validationN,
          12 + Math.round(52 * partial / CANDIDATES.length),
          true
        );
        await pause(0);
      }
    }

    validationResults.push({ weights: weights, distribution: distribution, score: metric(distribution) });
  }

  validationResults.sort(function (a, b) { return b.score - a.score; });
  const winner = validationResults[0];
  setUI(
    'VERIFICA FINALE SEPARATA…',
    'Il periodo finale non è stato usato per scegliere “' + winner.weights.name + '”.',
    72,
    true
  );
  await pause(20);

  const championHoldout = evaluateWindow(holdoutStart, draws.length, winner.weights, 'champ-holdout-v53');
  const randomHoldout = evaluateWindow(holdoutStart, draws.length, null, 'random-holdout-v53');

  model = {
    version: MODEL_VERSION,
    createdAt: new Date().toISOString(),
    weights: winner.weights,
    validationN: validationN,
    validation: winner.distribution,
    holdoutN: holdoutN,
    championHoldout: championHoldout,
    randomHoldout: randomHoldout,
    validationStart: draws[validationStart].date,
    validationEnd: draws[holdoutStart - 1].date,
    holdoutStart: draws[holdoutStart].date,
    holdoutEnd: draws[draws.length - 1].date
  };
  saveModel();
}

function createShadows(seed) {
  const rng = mulberry32(seed);
  const shadows = [];
  for (let i = 0; i < 1000; i += 1) shadows.push(sample6(rng));
  return shadows;
}

function findResultFor(record) {
  if (record.afterDrawDate) {
    return draws.find(function (draw) { return draw.date > record.afterDrawDate; });
  }
  const later = draws.find(function (draw) { return draw.date > record.generatedDate; });
  const same = draws.find(function (draw) { return draw.date === record.generatedDate; });
  return same || later;
}

function evaluatePending() {
  let changed = false;
  diary.forEach(function (record) {
    if (record.resultDate) return;
    const result = findResultFor(record);
    if (!result) return;

    record.resultDate = result.date;
    record.resultContest = result.contest || null;
    record.draw = result.nums;
    record.hits = hits(record.ticket, result.nums);
    if (!record.afterDrawDate && result.date === record.generatedDate) record.legacySameDay = true;

    const shadows = Array.isArray(record.shadows) ? record.shadows : [];
    if (shadows.length) {
      const shadowHits = shadows.map(function (ticket) { return hits(ticket, result.nums); });
      record.shadowDist = Array(7).fill(0);
      shadowHits.forEach(function (value) { record.shadowDist[value] += 1; });
      const below = shadowHits.filter(function (value) { return value < record.hits; }).length;
      const equal = shadowHits.filter(function (value) { return value === record.hits; }).length;
      record.percentile = Math.round(100 * (below + 0.5 * equal) / shadowHits.length);
      delete record.shadows;
    }

    if (record.played === true && record.hits < 2 && record.returnAmount == null) {
      record.returnAmount = 0;
    }
    changed = true;
  });
  if (changed) saveDiary();
}

async function easyUpdate() {
  if (busy) return;
  try {
    const failed = await updateArchive();
    setUI(
      'ARCHIVIO PRONTO',
      draws.length + ' estrazioni. ' + (failed.length ? 'Anni non letti: ' + failed.join(', ') : 'Confronti aggiornati.'),
      100,
      false
    );
  } catch (error) {
    setUI('ERRORE AGGIORNAMENTO', error.message, 0, false);
  }
}

async function easyAnalyze() {
  if (busy) return;
  try {
    setUI('ANALISI V5.3 IN CORSO…', 'Validazione e periodo finale separati.', 6, true);
    await analyzeV53();
    setUI('ANALISI COMPLETATA', 'Modello selezionato: ' + model.weights.name + '. Ora puoi generare.', 100, false);
    render();
  } catch (error) {
    setUI('ANALISI INTERROTTA', error.message, 0, false);
  }
}

function currentReference() {
  return draws.length ? draws[draws.length - 1] : null;
}

function pendingForReference(reference) {
  if (!reference) return null;
  return diary.find(function (record) {
    return !record.resultDate && record.afterDrawDate === reference.date;
  }) || null;
}

function easyGenerate() {
  if (busy) return;
  if (!model || model.version !== MODEL_VERSION || !model.weights) {
    setUI('PRIMA ANALIZZA', 'Premi “2 · Analizza tutto” per creare un modello V5.3 verificato.', 0, false);
    return;
  }
  const lastDraw = currentReference();
  if (!lastDraw) {
    setUI('ARCHIVIO MANCANTE', 'Premi prima “1 · Aggiorna archivio”.', 0, false);
    return;
  }

  const existing = pendingForReference(lastDraw);
  if (existing) {
    renderTicket(existing);
    setUI(
      'PROPOSTA GIÀ CREATA',
      'Per evitare selezione opportunistica resta valida una sola proposta dopo il concorso ' + (lastDraw.contest || lastDraw.date) + '.',
      100,
      false
    );
    return;
  }

  const now = new Date();
  const generatedAt = now.toISOString();
  const generatedDate = localDate(now);
  const seed = hashSeed(lastDraw.date + '-' + (lastDraw.contest || '') + '-' + generatedAt + '-v53');
  const rng = mulberry32(seed);
  const ticket = weightedTicket(draws.slice(-900), model.weights, rng);
  const shadows = createShadows(seed ^ 0x9e3779b9);
  const record = {
    id: 'g' + Date.now(),
    generatedAt: generatedAt,
    generatedDate: generatedDate,
    afterDrawDate: lastDraw.date,
    afterContest: lastDraw.contest || null,
    ticket: ticket,
    seed: seed,
    model: model.weights.name,
    shadows: shadows,
    played: null,
    cost: 0,
    returnAmount: null
  };
  diary.push(record);
  saveDiary();
  render();
  renderTicket(record);
  setUI('PROPOSTA GENERATA', ticket.join(' · ') + ' · non è ancora conteggiata come spesa.', 100, false);
}

function ballsHtml(ticket) {
  return ticket.map(function (n) {
    return '<span class="ball">' + Number(n) + '</span>';
  }).join('');
}

function playStateText(record) {
  if (record.played === true) return 'Giocata confermata · ' + formatMoney(record.cost || TICKET_COST);
  if (record.played === false) return 'Solo test · nessuna spesa';
  return 'Da confermare · nessuna spesa conteggiata';
}

function renderTicket(record) {
  const target = byId('ticketBox');
  if (!record || !Array.isArray(record.ticket)) {
    target.innerHTML = '';
    return;
  }

  let actions = '';
  if (!record.resultDate || record.played == null) {
    actions = '<div class="ticket-actions">' +
      '<button class="primary" type="button" data-ticket-action="played" data-id="' + escapeHtml(record.id) + '">Conferma: ho giocato 1 €</button>' +
      '<button class="secondary" type="button" data-ticket-action="test" data-id="' + escapeHtml(record.id) + '">Segna come solo test</button>' +
      '</div>';
  }

  target.innerHTML = '<div class="ticket-panel">' +
    '<h3>Proposta statistica V5.3</h3>' +
    '<div class="muted small">Creata dopo il concorso ' + escapeHtml(record.afterContest || record.afterDrawDate || 'non disponibile') + '.</div>' +
    '<div class="balls">' + ballsHtml(record.ticket) + '</div>' +
    '<span class="play-state">' + escapeHtml(playStateText(record)) + '</span>' +
    actions +
    '<p class="muted small">Le 1.000 sestine casuali sono già fissate. La proposta entra nel test anche se scegli di non acquistarla.</p>' +
    '</div>';
}

function spendForMonth(monthKey, excludingId) {
  return diary.reduce(function (sum, record) {
    const sameMonth = String(record.generatedDate || record.generatedAt || '').slice(0, 7) === monthKey;
    if (record.id !== excludingId && record.played === true && sameMonth) {
      return sum + (Number(record.cost) || TICKET_COST);
    }
    return sum;
  }, 0);
}

function setPlayState(recordId, state) {
  const record = diary.find(function (item) { return item.id === recordId; });
  if (!record) return false;

  if (state === true) {
    const monthKey = String(record.generatedDate || record.generatedAt || '').slice(0, 7);
    const alreadySpent = spendForMonth(monthKey, record.id);
    if (alreadySpent + TICKET_COST > monthlyBudget) {
      window.alert('Budget mensile raggiunto: questa proposta resta fuori dalle giocate monetarie. Puoi lasciarla come test.');
      render();
      return false;
    }
    record.played = true;
    record.cost = TICKET_COST;
    if (record.resultDate && Number(record.hits) < 2) record.returnAmount = 0;
  } else {
    record.played = false;
    record.cost = 0;
    record.returnAmount = null;
  }

  saveDiary();
  render();
  return true;
}

function renderCompare() {
  const target = byId('lastCompare');
  const record = diary.slice().reverse().find(function (item) {
    return item.resultDate && Array.isArray(item.shadowDist);
  });
  if (!record) {
    target.textContent = 'Nessun confronto completo. Le nuove proposte conserveranno il campione casuale fino alla verifica.';
    return;
  }

  const cells = record.shadowDist.map(function (count, hitCount) {
    return '<div class="compare-cell"><b>' + count + '</b><span>' + hitCount + ' numeri</span></div>';
  }).join('');

  let verdict = '<b>nella fascia centrale del campione casuale</b>';
  if (record.percentile >= 60) verdict = '<b class="positive">sopra il campione casuale</b>';
  if (record.percentile <= 40) verdict = '<b class="warning-text">sotto il campione casuale</b>';

  target.innerHTML = '<b>Estrazione ' + escapeHtml(record.resultDate) + '</b><br>' +
    'Estratti: ' + record.draw.map(Number).join(' · ') + '<br>' +
    'Proposta: <b>' + record.ticket.map(Number).join(' · ') + '</b> → <b>' + Number(record.hits) + '/6</b>' +
    '<div class="compare-grid">' + cells + '</div>' +
    '<div>Percentile: <b>' + Number(record.percentile) + '°</b> · ' + verdict + '</div>' +
    '<div class="small muted">Ogni casella conta quante delle 1.000 sestine virtuali hanno ottenuto quel numero di centri.</div>';
}

function renderBenchmark() {
  const target = byId('benchmark');
  const evaluated = diary.filter(function (record) {
    return record.resultDate && Number.isFinite(Number(record.percentile));
  });

  if (!evaluated.length) {
    target.textContent = 'Nessun risultato verificato con confronto casuale.';
    return;
  }

  const averageHits = evaluated.reduce(function (sum, record) {
    return sum + (Number(record.hits) || 0);
  }, 0) / evaluated.length;
  const averagePercentile = evaluated.reduce(function (sum, record) {
    return sum + Number(record.percentile);
  }, 0) / evaluated.length;
  const standardError = 28.87 / Math.sqrt(evaluated.length);
  const low = Math.max(0, averagePercentile - 1.96 * standardError);
  const high = Math.min(100, averagePercentile + 1.96 * standardError);

  let verdict;
  if (evaluated.length < 30) {
    verdict = '<b class="warning-text">Campione insufficiente per un verdetto.</b>';
  } else if (low > 50) {
    verdict = '<b class="positive">Segnale sopra il caso, da confermare su più estrazioni.</b>';
  } else if (high < 50) {
    verdict = '<b class="negative">Risultati inferiori al confronto casuale.</b>';
  } else {
    verdict = '<b>Risultati compatibili con il caso.</b>';
  }

  target.innerHTML = verdict + '<br>' +
    'Proposte confrontabili: ' + evaluated.length +
    ' · media hit: ' + averageHits.toFixed(2) +
    ' · percentile medio: ' + averagePercentile.toFixed(1) + '°' +
    ' · intervallo 95% circa: ' + low.toFixed(1) + '–' + high.toFixed(1) + '.<br>' +
    '<span class="small muted">Il calcolo include tutte le proposte, giocate e non giocate, per evitare di scegliere i risultati a posteriori.</span>';
}

function renderModel() {
  const target = byId('lab');
  if (!model) {
    target.textContent = 'Analisi non eseguita.';
    return;
  }
  if (model.version !== MODEL_VERSION) {
    target.innerHTML = '<b>Modello precedente rilevato.</b> Esegui nuovamente “Analizza tutto” per applicare la separazione validazione/periodo finale della V5.3.';
    return;
  }

  const championTwoPlus = sumFrom(model.championHoldout || [], 2);
  const randomTwoPlus = sumFrom(model.randomHoldout || [], 2);
  target.innerHTML = '<b>Modello selezionato:</b> ' + escapeHtml(model.weights.name) + '.<br>' +
    'Validazione: ' + Number(model.validationN) + ' concorsi (' + escapeHtml(model.validationStart) + ' → ' + escapeHtml(model.validationEnd) + ').<br>' +
    'Periodo finale mai usato nella scelta: ' + Number(model.holdoutN) + ' concorsi (' + escapeHtml(model.holdoutStart) + ' → ' + escapeHtml(model.holdoutEnd) + ').<br>' +
    'Nel periodo finale, risultati 2+: algoritmo ' + championTwoPlus + ' · casuale ' + randomTwoPlus + '.';
}

function realizedMoney() {
  const cash = diary.filter(function (record) { return record.played === true; });
  const spent = cash.reduce(function (sum, record) {
    return sum + (Number(record.cost) || TICKET_COST);
  }, 0);
  const settled = cash.filter(function (record) {
    if (!record.resultDate) return false;
    if (Number(record.hits) < 2) return true;
    return record.returnAmount !== '' && record.returnAmount != null && Number.isFinite(Number(record.returnAmount));
  });
  const settledSpent = settled.reduce(function (sum, record) {
    return sum + (Number(record.cost) || TICKET_COST);
  }, 0);
  const returns = settled.reduce(function (sum, record) {
    return sum + (Number(record.returnAmount) || 0);
  }, 0);
  const pendingDraws = cash.filter(function (record) { return !record.resultDate; }).length;
  const missingPrizes = cash.filter(function (record) {
    return record.resultDate && Number(record.hits) >= 2 && (record.returnAmount == null || record.returnAmount === '');
  }).length;
  return {
    cash: cash,
    spent: spent,
    settled: settled,
    settledSpent: settledSpent,
    returns: returns,
    profit: returns - settledSpent,
    roi: settledSpent ? (returns - settledSpent) / settledSpent * 100 : null,
    pendingDraws: pendingDraws,
    missingPrizes: missingPrizes
  };
}

function renderMoney() {
  const stats = realizedMoney();
  const currentMonth = localDate(new Date()).slice(0, 7);
  const monthSpent = spendForMonth(currentMonth, null);
  const remaining = Math.max(0, monthlyBudget - monthSpent);
  const ratio = monthlyBudget ? Math.min(100, monthSpent / monthlyBudget * 100) : 0;

  byId('kCashPlays').textContent = stats.cash.length;
  byId('kSpent').textContent = formatMoney(stats.spent);
  byId('kReturns').textContent = formatMoney(stats.returns);
  byId('kProfit').textContent = stats.settledSpent ? formatMoney(stats.profit) : '—';
  byId('kProfit').className = stats.profit > 0 ? 'positive' : stats.profit < 0 ? 'negative' : '';
  byId('kRoi').textContent = stats.roi == null ? '—' : stats.roi.toFixed(1) + '%';
  byId('kRoi').className = stats.roi > 0 ? 'positive' : stats.roi < 0 ? 'negative' : '';
  byId('kMonth').textContent = formatMoney(monthSpent);

  const budgetBar = byId('budgetBar');
  budgetBar.style.width = ratio + '%';
  budgetBar.className = ratio >= 100 ? 'full' : ratio >= 75 ? 'warning' : '';

  const messages = ['Disponibili questo mese: ' + formatMoney(remaining) + ' su ' + formatMoney(monthlyBudget) + '.'];
  if (!stats.cash.length) messages.push('Nessuna proposta è ancora conteggiata come spesa.');
  if (stats.pendingDraws) messages.push(stats.pendingDraws + ' giocata/e attendono l’estrazione.');
  if (stats.missingPrizes) messages.push('Inserisci l’incasso di ' + stats.missingPrizes + ' giocata/e premiata/e per completare il ROI.');
  if (stats.settledSpent) messages.push('Profitto e ROI usano soltanto giocate già definite.');
  byId('moneyStatus').textContent = messages.join(' ');
}

function statusOptions(record) {
  const selectedUnknown = record.played == null ? ' selected' : '';
  const selectedPlayed = record.played === true ? ' selected' : '';
  const selectedTest = record.played === false ? ' selected' : '';
  return '<select data-field="played" data-id="' + escapeHtml(record.id) + '" aria-label="Stato proposta">' +
    '<option value="unknown"' + selectedUnknown + '>Da confermare</option>' +
    '<option value="played"' + selectedPlayed + '>Giocata 1 €</option>' +
    '<option value="test"' + selectedTest + '>Solo test</option>' +
    '</select>';
}

function returnField(record) {
  if (record.played !== true || !record.resultDate) return '—';
  if (Number(record.hits) < 2) return formatMoney(0);
  const value = record.returnAmount == null ? '' : Number(record.returnAmount).toFixed(2);
  return '<input data-field="return" data-id="' + escapeHtml(record.id) + '" type="number" min="0" step="0.01" inputmode="decimal" value="' + escapeHtml(value) + '" placeholder="€ 0,00" aria-label="Incasso effettivo">';
}

function renderDiary() {
  const target = byId('diary');
  if (!diary.length) {
    target.innerHTML = '<div class="status">Nessuna proposta registrata.</div>';
    return;
  }

  const rows = diary.slice().reverse().map(function (record) {
    const result = record.resultDate ? escapeHtml(record.resultDate) + (record.legacySameDay ? '*' : '') : 'in attesa';
    const hitText = record.hits == null ? '—' : Number(record.hits) + '/6';
    const percentile = record.percentile == null ? '—' : Number(record.percentile) + '°';
    const cost = record.played === true ? formatMoney(record.cost || TICKET_COST) : formatMoney(0);
    return '<tr>' +
      '<td>' + escapeHtml(record.generatedDate || '') + '</td>' +
      '<td><b>' + record.ticket.map(Number).join(' ') + '</b></td>' +
      '<td>' + statusOptions(record) + '</td>' +
      '<td>' + result + '</td>' +
      '<td>' + hitText + '</td>' +
      '<td>' + percentile + '</td>' +
      '<td>' + cost + '</td>' +
      '<td>' + returnField(record) + '</td>' +
      '</tr>';
  }).join('');

  const legacyNote = diary.some(function (record) { return record.legacySameDay; })
    ? '<div class="small muted">* Proposta di una versione precedente, abbinata all’estrazione dello stesso giorno perché il vecchio formato non salvava il concorso di riferimento.</div>'
    : '';

  target.innerHTML = '<table class="diary-table"><thead><tr>' +
    '<th>Creata</th><th>Sestina</th><th>Stato</th><th>Estrazione</th><th>Hit</th><th>vs 1.000</th><th>Costo</th><th>Incasso €</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + legacyNote;
}

function render() {
  evaluatePending();
  const pending = diary.filter(function (record) { return !record.resultDate; });
  const evaluated = diary.filter(function (record) { return record.resultDate; });

  byId('kDraws').textContent = draws.length;
  byId('kPending').textContent = pending.length;
  byId('kEvaluated').textContent = evaluated.length;
  byId('kAvg').textContent = evaluated.length
    ? (evaluated.reduce(function (sum, record) { return sum + (Number(record.hits) || 0); }, 0) / evaluated.length).toFixed(2)
    : '—';

  renderModel();
  renderDiary();
  renderBenchmark();
  renderCompare();
  renderMoney();

  const reference = currentReference();
  const pendingRecord = pendingForReference(reference);
  if (pendingRecord) renderTicket(pendingRecord);
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return '"' + text.replaceAll('"', '""') + '"';
}

function exportDiary() {
  if (!diary.length) {
    window.alert('Il diario è vuoto.');
    return;
  }

  const header = [
    'generata', 'sestina', 'stato', 'estrazione', 'estratti', 'hit', 'percentile', 'costo', 'incasso', 'profitto'
  ];
  const rows = diary.map(function (record) {
    const state = record.played === true ? 'giocata' : record.played === false ? 'solo test' : 'da confermare';
    const cost = record.played === true ? Number(record.cost) || TICKET_COST : 0;
    const hasReturn = record.returnAmount !== '' && record.returnAmount != null && Number.isFinite(Number(record.returnAmount));
    const amount = hasReturn ? Number(record.returnAmount) : '';
    const profit = record.played === true && record.resultDate && (Number(record.hits) < 2 || hasReturn)
      ? Number(amount || 0) - cost
      : '';
    return [
      record.generatedDate,
      record.ticket.join(' '),
      state,
      record.resultDate || '',
      (record.draw || []).join(' '),
      record.hits == null ? '' : record.hits,
      record.percentile == null ? '' : record.percentile,
      cost,
      amount,
      profit
    ].map(csvCell).join(',');
  });

  const blob = new Blob(['\uFEFF' + header.map(csvCell).join(',') + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = 'superenalotto_v53_diario.csv';
  link.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 0);
}

function resetDiary() {
  if (!window.confirm('Cancellare tutto il diario V5, comprese conferme di spesa e incassi?')) return;
  diary = [];
  localStorage.removeItem(V5_DIARY);
  byId('ticketBox').innerHTML = '';
  render();
}

function onDiaryChange(event) {
  const field = event.target.dataset.field;
  const recordId = event.target.dataset.id;
  if (!field || !recordId) return;

  if (field === 'played') {
    if (event.target.value === 'played') setPlayState(recordId, true);
    else if (event.target.value === 'test') setPlayState(recordId, false);
    else {
      const record = diary.find(function (item) { return item.id === recordId; });
      if (record) {
        record.played = null;
        record.cost = 0;
        record.returnAmount = null;
        saveDiary();
        render();
      }
    }
  }
}

function onDiaryInput(event) {
  if (event.target.dataset.field !== 'return') return;
  const record = diary.find(function (item) { return item.id === event.target.dataset.id; });
  if (!record) return;
  const raw = event.target.value.trim();
  record.returnAmount = raw === '' ? null : Math.max(0, Number(raw) || 0);
  saveDiary();
  renderMoney();
}

function onTicketAction(event) {
  const button = event.target.closest('[data-ticket-action]');
  if (!button) return;
  setPlayState(button.dataset.id, button.dataset.ticketAction === 'played');
}

function onBudgetChange() {
  const value = Math.min(100, Math.max(1, Math.round(Number(byId('monthlyBudget').value) || DEFAULT_BUDGET)));
  monthlyBudget = value;
  byId('monthlyBudget').value = value;
  saveBudget();
  renderMoney();
}

byId('bUpdate').addEventListener('click', easyUpdate);
byId('bAnalyze').addEventListener('click', easyAnalyze);
byId('bGenerate').addEventListener('click', easyGenerate);
byId('exportBtn').addEventListener('click', exportDiary);
byId('resetBtn').addEventListener('click', resetDiary);
byId('monthlyBudget').addEventListener('change', onBudgetChange);
byId('diary').addEventListener('change', onDiaryChange);
byId('diary').addEventListener('input', onDiaryInput);
byId('ticketBox').addEventListener('click', onTicketAction);

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', function (event) {
  event.preventDefault();
  deferredInstallPrompt = event;
});

window.addEventListener('appinstalled', function () {
  deferredInstallPrompt = null;
  byId('installBtn').textContent = 'Installata';
  setUI('APP INSTALLATA', 'La scorciatoia usa ora l’icona SuperEnalotto.', 100, false);
});

byId('installBtn').addEventListener('click', async function () {
  if (window.matchMedia('(display-mode: standalone)').matches) {
    setUI('APP GIÀ INSTALLATA', 'La stai usando in modalità autonoma.', 100, false);
    return;
  }
  if (!deferredInstallPrompt) {
    setUI('INSTALLAZIONE DAL MENU', 'Apri ⋮ in Chrome e scegli “Installa app” o “Aggiungi a schermata Home”.', 0, false);
    return;
  }
  await deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  setUI(choice.outcome === 'accepted' ? 'INSTALLAZIONE AVVIATA' : 'INSTALLAZIONE ANNULLATA', 'Puoi riprovare in qualsiasi momento.', choice.outcome === 'accepted' ? 100 : 0, false);
  deferredInstallPrompt = null;
});

byId('updateAppBtn').addEventListener('click', async function () {
  byId('updateAppBtn').disabled = true;
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) await registration.update();
    }
    await fetch('./index.html?refresh=' + Date.now(), { cache: 'no-store' });
    setUI('AGGIORNAMENTO CONTROLLATO', 'Ricarico la versione più recente…', 100, false);
    setTimeout(function () { window.location.reload(); }, 450);
  } catch (_error) {
    setUI('AGGIORNAMENTO NON RIUSCITO', 'Controlla la connessione e riprova.', 0, false);
    byId('updateAppBtn').disabled = false;
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./service-worker.js').catch(function () {});
  });
}

load();
