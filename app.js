'use strict';

const STORE = 'se_v31_archive';
const MODEL_STORE = 'se_v6_model';
const LEGACY_MODEL_STORE = 'se_v5_model';
const DIARY_STORE = 'se_v5_diary';
const BUDGET_STORE = 'se_v53_budget';
const MODEL_VERSION = 'V6.0';
const DEFAULT_BUDGET = 4;
const TICKET_COST = 1;
const PORTFOLIO_SIZE = 4;
const POOL_SIZE = 18;
const SHADOW_PORTFOLIOS = 1000;

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
  { name: 'Quasi neutra', freq: 0.18, delay: 0.03, anti: 0.03 },
  { name: 'Bilanciata soft', freq: 0.30, delay: 0.08, anti: 0.04 },
  { name: 'Frequenza soft', freq: 0.46, delay: 0.02, anti: 0.04 },
  { name: 'Ritardo soft', freq: 0.18, delay: 0.24, anti: 0.03 },
  { name: 'Anti-folla soft', freq: 0.22, delay: 0.05, anti: 0.20 }
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setUI(main, sub, pct, isBusy) {
  const message = isBusy ? '<span class="spinner" aria-hidden="true"></span>' + main : main;
  byId('mainStatus').innerHTML = message;
  byId('mainSub').textContent = sub || '';
  byId('mainBar').style.width = clamp(pct || 0, 0, 100) + '%';
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
  localStorage.setItem(DIARY_STORE, JSON.stringify(diary));
}

function saveModel() {
  localStorage.setItem(MODEL_STORE, JSON.stringify(model));
}

function saveBudget() {
  localStorage.setItem(BUDGET_STORE, JSON.stringify(monthlyBudget));
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

function normalizeTickets(record) {
  if (Array.isArray(record.tickets) && record.tickets.length) {
    return record.tickets
      .filter(Array.isArray)
      .map(function (ticket) {
        return ticket.map(Number).filter(function (n) { return n >= 1 && n <= 90; }).slice(0, 6).sort(function (a, b) { return a - b; });
      })
      .filter(function (ticket) { return ticket.length === 6 && new Set(ticket).size === 6; });
  }
  if (Array.isArray(record.ticket) && record.ticket.length === 6) {
    return [record.ticket.map(Number).sort(function (a, b) { return a - b; })];
  }
  return [];
}

function migrateDiary() {
  let changed = false;
  diary.forEach(function (record) {
    const tickets = normalizeTickets(record);
    if (!Array.isArray(record.tickets) || record.tickets.length !== tickets.length) {
      record.tickets = tickets;
      changed = true;
    }
    if (!record.ticket && tickets[0]) {
      record.ticket = tickets[0];
      changed = true;
    }
    if (!Number.isFinite(Number(record.portfolioSize)) || Number(record.portfolioSize) < 1) {
      record.portfolioSize = Math.max(1, tickets.length);
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(record, 'played')) {
      record.played = null;
      changed = true;
    }
    if (!Number.isFinite(Number(record.playedLines))) {
      record.playedLines = record.played === true ? Math.max(1, Math.round(Number(record.cost) || 1)) : 0;
      changed = true;
    }
    if (record.played === true) {
      const legalLines = clamp(Math.round(Number(record.playedLines) || 1), 1, Math.max(1, tickets.length));
      if (record.playedLines !== legalLines) {
        record.playedLines = legalLines;
        changed = true;
      }
      const expectedCost = legalLines * TICKET_COST;
      if (Number(record.cost) !== expectedCost) {
        record.cost = expectedCost;
        changed = true;
      }
    } else {
      if (Number(record.playedLines) !== 0) {
        record.playedLines = 0;
        changed = true;
      }
      if (Number(record.cost) !== 0) {
        record.cost = 0;
        changed = true;
      }
    }
    if (record.resultDate && !Array.isArray(record.lineHits) && tickets.length) {
      const lineHits = tickets.map(function (ticket) { return hits(ticket, record.draw || []); });
      record.lineHits = lineHits;
      record.bestHits = lineHits.length ? Math.max.apply(null, lineHits) : Number(record.hits) || 0;
      record.totalHits = lineHits.reduce(function (sum, value) { return sum + value; }, 0);
      record.hits = record.bestHits;
      changed = true;
    }
    if (record.resultDate && record.played === true) {
      refreshPlayedOutcome(record);
      if (playedPrizeThreshold(record) < 2 && record.returnAmount == null) {
        record.returnAmount = 0;
        changed = true;
      }
    }
  });
  if (changed) saveDiary();
}

function load() {
  draws = dedupeDraws(safeParse(STORE, []));
  model = safeParse(MODEL_STORE, null);
  if (!model) {
    const legacyModel = safeParse(LEGACY_MODEL_STORE, null);
    if (legacyModel && legacyModel.version === MODEL_VERSION) model = legacyModel;
  }
  diary = safeParse(DIARY_STORE, []);
  if (!Array.isArray(diary)) diary = [];

  const storedBudget = Number(safeParse(BUDGET_STORE, DEFAULT_BUDGET));
  monthlyBudget = Number.isFinite(storedBudget)
    ? clamp(Math.round(storedBudget), 1, 100)
    : DEFAULT_BUDGET;
  byId('monthlyBudget').value = monthlyBudget;

  migrateDiary();
  evaluatePending();
  render();
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

function archiveCoverage() {
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
  const currentCoverage = archiveCoverage();
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
    await pause(20);
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
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
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
  if (!Array.isArray(ticket) || !Array.isArray(extracted)) return 0;
  return ticket.filter(function (n) { return extracted.includes(n); }).length;
}

function buildStats(history) {
  const count = Array(91).fill(0);
  const last = Array(91).fill(-1);
  history.forEach(function (draw, index) {
    draw.nums.forEach(function (n) {
      count[n] += 1;
      last[n] = index;
    });
  });
  return { total: history.length, count: count, last: last };
}

function numberScore(n, stats, weights) {
  const expected = Math.max(1, stats.total * 6 / 90);
  const freqRatio = stats.count[n] / expected;
  const freqSignal = clamp(freqRatio - 1, -0.35, 0.35);
  const gap = stats.last[n] < 0 ? 14 : Math.max(0, stats.total - 1 - stats.last[n]);
  const delaySignal = clamp((gap - 14) / 42, -0.35, 0.35);
  const antiSignal = n <= 31 ? -0.06 : 0.025;
  return Math.max(0.25,
    1 +
    weights.freq * freqSignal +
    weights.delay * delaySignal +
    weights.anti * antiSignal
  );
}

function baseScores(stats, weights) {
  const scores = Array(91).fill(0);
  for (let n = 1; n <= 90; n += 1) scores[n] = numberScore(n, stats, weights);
  return scores;
}

function sampleWeighted6(scores, usage, rng) {
  const selected = [];
  while (selected.length < 6) {
    let total = 0;
    const pool = [];
    for (let n = 1; n <= 90; n += 1) {
      if (selected.includes(n)) continue;
      const used = usage ? Number(usage[n] || 0) : 0;
      const diversityPenalty = used === 0 ? 1 : used === 1 ? 0.12 : 0.025;
      const score = Math.max(0.001, scores[n] * diversityPenalty);
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

function generatePortfolio(history, weights, count, rng) {
  const stats = buildStats(history);
  const scores = baseScores(stats, weights);
  const usage = Array(91).fill(0);
  const tickets = [];

  for (let line = 0; line < count; line += 1) {
    const ticket = sampleWeighted6(scores, usage, rng);
    ticket.forEach(function (n) { usage[n] += 1; });
    tickets.push(ticket);
  }
  return tickets;
}

function randomPortfolio(count, rng) {
  const tickets = [];
  for (let i = 0; i < count; i += 1) tickets.push(sample6(rng));
  return tickets;
}

function ticketPairs(ticket) {
  const keys = [];
  for (let i = 0; i < ticket.length; i += 1) {
    for (let j = i + 1; j < ticket.length; j += 1) {
      keys.push(ticket[i] + '-' + ticket[j]);
    }
  }
  return keys;
}

function portfolioCoverage(tickets) {
  const allNumbers = new Set();
  const allPairs = new Set();
  let maxOverlap = 0;

  tickets.forEach(function (ticket, index) {
    ticket.forEach(function (n) { allNumbers.add(n); });
    ticketPairs(ticket).forEach(function (pair) { allPairs.add(pair); });
    for (let j = 0; j < index; j += 1) {
      const overlap = hits(ticket, tickets[j]);
      maxOverlap = Math.max(maxOverlap, overlap);
    }
  });

  const maxNumbers = Math.max(1, tickets.length * 6);
  const maxPairs = Math.max(1, tickets.length * 15);
  const score = Math.round(100 * (0.55 * allNumbers.size / maxNumbers + 0.45 * allPairs.size / maxPairs));
  return {
    uniqueNumbers: allNumbers.size,
    uniquePairs: allPairs.size,
    maxOverlap: maxOverlap,
    score: clamp(score, 0, 100)
  };
}

function analyticalPool(history, weights, size) {
  const stats = buildStats(history);
  const scores = baseScores(stats, weights);
  return Array.from({ length: 90 }, function (_unused, index) { return index + 1; })
    .sort(function (a, b) { return scores[b] - scores[a] || a - b; })
    .slice(0, size);
}

function portfolioOutcome(tickets, extracted) {
  const lineHits = tickets.map(function (ticket) { return hits(ticket, extracted); });
  return {
    lineHits: lineHits,
    best: lineHits.length ? Math.max.apply(null, lineHits) : 0,
    total: lineHits.reduce(function (sum, value) { return sum + value; }, 0),
    lines2plus: lineHits.filter(function (value) { return value >= 2; }).length
  };
}

function emptyStrategySummary() {
  return {
    n: 0,
    bestDist: Array(7).fill(0),
    any2plus: 0,
    zeroTotal: 0,
    totalHits: 0,
    sumBest: 0
  };
}

function addOutcome(summary, outcome) {
  summary.n += 1;
  summary.bestDist[outcome.best] += 1;
  if (outcome.best >= 2) summary.any2plus += 1;
  if (outcome.total === 0) summary.zeroTotal += 1;
  summary.totalHits += outcome.total;
  summary.sumBest += outcome.best;
}

function strategyScore(summary) {
  return summary.any2plus * 10000 +
    (summary.bestDist[3] || 0) * 900 +
    (summary.bestDist[4] || 0) * 5000 +
    (summary.bestDist[5] || 0) * 25000 +
    (summary.bestDist[6] || 0) * 100000 +
    summary.sumBest * 10 + summary.totalHits;
}

function evaluateStrategyWindow(start, end, weights, count, seedLabel, isRandom) {
  const summary = emptyStrategySummary();
  for (let index = start; index < end; index += 1) {
    const history = draws.slice(Math.max(0, index - 900), index);
    const rng = mulberry32(hashSeed(index + '-' + seedLabel + '-' + count));
    const tickets = isRandom
      ? randomPortfolio(count, rng)
      : generatePortfolio(history, weights, count, rng);
    addOutcome(summary, portfolioOutcome(tickets, draws[index].nums));
  }
  return summary;
}

async function analyzeV6() {
  if (draws.length < 900) {
    throw new Error('Archivio insufficiente: ' + draws.length + ' estrazioni. Aggiornalo prima.');
  }

  const holdoutN = Math.min(160, Math.max(100, Math.floor(draws.length * 0.045)));
  const validationN = Math.min(260, Math.max(170, Math.floor(draws.length * 0.07)));
  const holdoutStart = draws.length - holdoutN;
  const validationStart = holdoutStart - validationN;
  const validationResults = [];

  for (let candidateIndex = 0; candidateIndex < CANDIDATES.length; candidateIndex += 1) {
    const weights = CANDIDATES[candidateIndex];
    const summary = emptyStrategySummary();

    for (let index = validationStart; index < holdoutStart; index += 1) {
      const history = draws.slice(Math.max(0, index - 900), index);
      const rng = mulberry32(hashSeed(index + '-' + candidateIndex + '-validation-v60'));
      const tickets = generatePortfolio(history, weights, PORTFOLIO_SIZE, rng);
      addOutcome(summary, portfolioOutcome(tickets, draws[index].nums));

      if ((index - validationStart) % 35 === 0) {
        const partial = candidateIndex + (index - validationStart) / validationN;
        setUI(
          'ANALISI V6 IN CORSO…',
          'Validazione · ' + weights.name + ' · ' + (index - validationStart + 1) + '/' + validationN,
          10 + Math.round(52 * partial / CANDIDATES.length),
          true
        );
        await pause(0);
      }
    }

    validationResults.push({ weights: weights, summary: summary, score: strategyScore(summary) });
  }

  validationResults.sort(function (a, b) { return b.score - a.score; });
  const winner = validationResults[0];
  const randomValidation = evaluateStrategyWindow(
    validationStart,
    holdoutStart,
    null,
    PORTFOLIO_SIZE,
    'random-validation-v60',
    true
  );

  setUI(
    'VERIFICA FINALE SEPARATA…',
    'Il periodo finale non è stato usato per scegliere “' + winner.weights.name + '”.',
    70,
    true
  );
  await pause(20);

  const holdout = {};
  const counts = [1, 2, 4];
  for (let i = 0; i < counts.length; i += 1) {
    const count = counts[i];
    setUI(
      'BACKTEST HOLDOUT…',
      'Confronto a ' + count + (count === 1 ? ' linea' : ' linee') + ' · ' + (i + 1) + '/3',
      74 + Math.round(20 * i / counts.length),
      true
    );
    await pause(0);
    holdout[String(count)] = {
      algorithm: evaluateStrategyWindow(holdoutStart, draws.length, winner.weights, count, 'algo-holdout-v60', false),
      random: evaluateStrategyWindow(holdoutStart, draws.length, null, count, 'random-holdout-v60', true)
    };
  }

  model = {
    version: MODEL_VERSION,
    createdAt: new Date().toISOString(),
    weights: winner.weights,
    validationN: validationN,
    validation: winner.summary,
    randomValidation: randomValidation,
    holdoutN: holdoutN,
    holdout: holdout,
    validationStart: draws[validationStart].date,
    validationEnd: draws[holdoutStart - 1].date,
    holdoutStart: draws[holdoutStart].date,
    holdoutEnd: draws[draws.length - 1].date
  };
  saveModel();
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

function findResultFor(record) {
  if (record.afterDrawDate) {
    return draws.find(function (draw) { return draw.date > record.afterDrawDate; });
  }
  const later = draws.find(function (draw) { return draw.date > record.generatedDate; });
  const same = draws.find(function (draw) { return draw.date === record.generatedDate; });
  return same || later;
}

function compareScore(outcome) {
  return outcome.best * 100 + outcome.total;
}

function createShadowComparison(record, result) {
  const count = Math.max(1, Number(record.portfolioSize) || normalizeTickets(record).length || 1);
  const seed = Number(record.shadowSeed) || (Number(record.seed) ^ 0x9e3779b9) || hashSeed(record.id + '-shadow-v60');
  const rng = mulberry32(seed >>> 0);
  const actualOutcome = portfolioOutcome(normalizeTickets(record), result.nums);
  const actualScore = compareScore(actualOutcome);
  const dist = Array(7).fill(0);
  let below = 0;
  let equal = 0;

  for (let i = 0; i < SHADOW_PORTFOLIOS; i += 1) {
    const randomTickets = randomPortfolio(count, rng);
    const outcome = portfolioOutcome(randomTickets, result.nums);
    dist[outcome.best] += 1;
    const score = compareScore(outcome);
    if (score < actualScore) below += 1;
    else if (score === actualScore) equal += 1;
  }

  record.shadowDist = dist;
  record.percentile = Math.round(100 * (below + 0.5 * equal) / SHADOW_PORTFOLIOS);
}

function refreshPlayedOutcome(record) {
  const lineHits = Array.isArray(record.lineHits) ? record.lineHits : [];
  if (record.played !== true) {
    record.playedBestHits = null;
    record.playedTotalHits = null;
    return;
  }
  const playedLines = clamp(Math.round(Number(record.playedLines) || 1), 1, Math.max(1, lineHits.length || 1));
  const played = lineHits.slice(0, playedLines);
  record.playedBestHits = played.length ? Math.max.apply(null, played) : 0;
  record.playedTotalHits = played.reduce(function (sum, value) { return sum + value; }, 0);
}

function playedPrizeThreshold(record) {
  if (record.played !== true) return 0;
  if (Number.isFinite(Number(record.playedBestHits))) return Number(record.playedBestHits);
  return Number(record.hits) || 0;
}

function evaluatePending() {
  let changed = false;
  diary.forEach(function (record) {
    if (record.resultDate) return;
    const result = findResultFor(record);
    if (!result) return;

    const tickets = normalizeTickets(record);
    const outcome = portfolioOutcome(tickets, result.nums);
    record.resultDate = result.date;
    record.resultContest = result.contest || null;
    record.draw = result.nums;
    record.lineHits = outcome.lineHits;
    record.bestHits = outcome.best;
    record.totalHits = outcome.total;
    record.hits = outcome.best;
    if (!record.afterDrawDate && result.date === record.generatedDate) record.legacySameDay = true;

    if (Array.isArray(record.shadows) && record.shadows.length) {
      const shadowHits = record.shadows.map(function (ticket) { return hits(ticket, result.nums); });
      record.shadowDist = Array(7).fill(0);
      shadowHits.forEach(function (value) { record.shadowDist[value] += 1; });
      const below = shadowHits.filter(function (value) { return value < outcome.best; }).length;
      const equal = shadowHits.filter(function (value) { return value === outcome.best; }).length;
      record.percentile = Math.round(100 * (below + 0.5 * equal) / shadowHits.length);
      delete record.shadows;
    } else {
      createShadowComparison(record, result);
    }

    refreshPlayedOutcome(record);
    if (record.played === true && playedPrizeThreshold(record) < 2 && record.returnAmount == null) {
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
      draws.length + ' estrazioni. ' + (failed.length ? 'Anni non letti: ' + failed.join(', ') : 'Portafogli in attesa verificati.'),
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
    setUI('ANALISI V6 IN CORSO…', 'Validazione, copertura e holdout separati.', 6, true);
    await analyzeV6();
    setUI('ANALISI COMPLETATA', 'Modello selezionato: ' + model.weights.name + '. Ora puoi generare il portafoglio.', 100, false);
    render();
  } catch (error) {
    setUI('ANALISI INTERROTTA', error.message, 0, false);
  }
}

function easyGenerate() {
  if (busy) return;
  if (!model || model.version !== MODEL_VERSION || !model.weights) {
    setUI('PRIMA ANALIZZA', 'Premi “2 · Analizza tutto” per creare il modello V6 verificato.', 0, false);
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
      'PORTAFOGLIO GIÀ CREATO',
      'Per evitare selezione opportunistica resta valido quello generato dopo il concorso ' + (lastDraw.contest || lastDraw.date) + '.',
      100,
      false
    );
    return;
  }

  const now = new Date();
  const generatedAt = now.toISOString();
  const generatedDate = localDate(now);
  const seed = hashSeed(lastDraw.date + '-' + (lastDraw.contest || '') + '-' + generatedAt + '-v60');
  const rng = mulberry32(seed);
  const history = draws.slice(-900);
  const tickets = generatePortfolio(history, model.weights, PORTFOLIO_SIZE, rng);
  const pool = analyticalPool(history, model.weights, POOL_SIZE);
  const cover = portfolioCoverage(tickets);

  const record = {
    id: 'g' + Date.now(),
    generatedAt: generatedAt,
    generatedDate: generatedDate,
    afterDrawDate: lastDraw.date,
    afterContest: lastDraw.contest || null,
    ticket: tickets[0],
    tickets: tickets,
    portfolioSize: tickets.length,
    pool: pool,
    coverage: cover,
    seed: seed,
    shadowSeed: (seed ^ 0x9e3779b9) >>> 0,
    model: model.weights.name,
    played: null,
    playedLines: 0,
    cost: 0,
    returnAmount: null
  };

  diary.push(record);
  saveDiary();
  render();
  renderTicket(record);
  setUI(
    'PORTAFOGLIO GENERATO',
    cover.uniqueNumbers + ' numeri distinti su 24 posti · sovrapposizione massima ' + cover.maxOverlap + '. Nessuna spesa ancora conteggiata.',
    100,
    false
  );
}

function ballsHtml(ticket) {
  return ticket.map(function (n) {
    return '<span class="ball">' + Number(n) + '</span>';
  }).join('');
}

function compactTicketsHtml(tickets) {
  return tickets.map(function (ticket, index) {
    return '<div class="portfolio-line"><span class="line-no">' + (index + 1) + '</span><div class="balls compact-balls">' + ballsHtml(ticket) + '</div></div>';
  }).join('');
}

function playStateText(record) {
  if (record.played === true) {
    return 'Giocato · ' + Number(record.playedLines || 1) + (Number(record.playedLines || 1) === 1 ? ' linea' : ' linee') + ' · ' + formatMoney(record.cost);
  }
  if (record.played === false) return 'Solo test · nessuna spesa';
  return 'Da confermare · nessuna spesa conteggiata';
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

function availableBudgetFor(record) {
  const monthKey = String(record.generatedDate || record.generatedAt || '').slice(0, 7);
  return Math.max(0, monthlyBudget - spendForMonth(monthKey, record.id));
}

function renderTicket(record) {
  const target = byId('ticketBox');
  const tickets = record ? normalizeTickets(record) : [];
  if (!record || !tickets.length) {
    target.innerHTML = '';
    return;
  }

  const cover = record.coverage || portfolioCoverage(tickets);
  let actions = '';
  if (!record.resultDate && record.played == null) {
    const available = Math.floor(availableBudgetFor(record));
    const maxPlayable = Math.min(tickets.length, available);
    const buttons = [];
    for (let lines = 1; lines <= maxPlayable; lines += 1) {
      buttons.push(
        '<button class="' + (lines === 1 ? 'primary' : '') + '" type="button" data-ticket-action="play" data-lines="' + lines + '" data-id="' + escapeHtml(record.id) + '">' +
        'Gioca ' + lines + (lines === 1 ? ' linea' : ' linee') + ' · ' + formatMoney(lines * TICKET_COST) +
        '</button>'
      );
    }
    if (!buttons.length) {
      buttons.push('<span class="warning-text small">Budget mensile esaurito: il portafoglio può restare solo nel test.</span>');
    }
    actions = '<div class="ticket-actions">' + buttons.join('') +
      '<button class="secondary" type="button" data-ticket-action="test" data-id="' + escapeHtml(record.id) + '">Segna come solo test</button>' +
      '</div>';
  }

  const poolText = Array.isArray(record.pool) && record.pool.length
    ? record.pool.map(Number).join(' · ')
    : 'non disponibile per le proposte precedenti';

  target.innerHTML = '<div class="ticket-panel">' +
    '<div class="section-head ticket-head"><div><h3>Portafoglio V6 · 4 linee</h3>' +
    '<div class="muted small">Creato dopo il concorso ' + escapeHtml(record.afterContest || record.afterDrawDate || 'non disponibile') + ' · modello ' + escapeHtml(record.model || 'precedente') + '.</div></div>' +
    '<span class="play-state">' + escapeHtml(playStateText(record)) + '</span></div>' +
    '<div class="portfolio-grid">' + compactTicketsHtml(tickets) + '</div>' +
    '<div class="coverage-strip"><span><b>' + cover.uniqueNumbers + '</b> numeri distinti</span><span><b>' + cover.uniquePairs + '</b> coppie distinte</span><span><b>' + cover.maxOverlap + '</b> overlap max</span><span><b>' + cover.score + '%</b> copertura interna</span></div>' +
    actions +
    '<details class="mini-details"><summary>Pool analitico di ' + (Array.isArray(record.pool) ? record.pool.length : '—') + ' numeri</summary><div class="pool-numbers">' + escapeHtml(poolText) + '</div></details>' +
    '<p class="muted small ticket-note">Le 4 linee restano nel diario anche se ne giochi soltanto una. Il vantaggio cercato è evitare duplicazioni inutili; non cambia l’equiprobabilità delle sestine.</p>' +
    '</div>';
}

function setPlayState(recordId, state, lines) {
  const record = diary.find(function (item) { return item.id === recordId; });
  if (!record) return false;
  if (record.resultDate) {
    window.alert('Il risultato è già disponibile: stato e costo sono congelati per evitare modifiche a posteriori.');
    return false;
  }

  if (state === true) {
    const tickets = normalizeTickets(record);
    const chosenLines = clamp(Math.round(Number(lines) || 1), 1, Math.max(1, tickets.length));
    const cost = chosenLines * TICKET_COST;
    const monthKey = String(record.generatedDate || record.generatedAt || '').slice(0, 7);
    const alreadySpent = spendForMonth(monthKey, record.id);
    if (alreadySpent + cost > monthlyBudget) {
      window.alert('Budget mensile insufficiente per ' + chosenLines + ' linee. Puoi scegliere meno linee o lasciare il portafoglio come test.');
      render();
      return false;
    }
    record.played = true;
    record.playedLines = chosenLines;
    record.cost = cost;
    record.returnAmount = null;
  } else {
    record.played = false;
    record.playedLines = 0;
    record.cost = 0;
    record.returnAmount = null;
  }

  saveDiary();
  render();
  return true;
}

function renderCoverage() {
  const reference = currentReference();
  let record = pendingForReference(reference);
  if (!record) record = diary.length ? diary[diary.length - 1] : null;

  if (!record || !normalizeTickets(record).length) {
    byId('kPoolCount').textContent = '—';
    byId('kUniqueNumbers').textContent = '—';
    byId('kMaxOverlap').textContent = '—';
    byId('kCoverageScore').textContent = '—';
    byId('coverageDetail').textContent = 'Genera un portafoglio per vedere la copertura effettiva.';
    return;
  }

  const tickets = normalizeTickets(record);
  const cover = record.coverage || portfolioCoverage(tickets);
  byId('kPoolCount').textContent = Array.isArray(record.pool) ? record.pool.length : '—';
  byId('kUniqueNumbers').textContent = cover.uniqueNumbers + '/' + (tickets.length * 6);
  byId('kMaxOverlap').textContent = cover.maxOverlap;
  byId('kCoverageScore').textContent = cover.score + '%';

  let quality = 'Copertura interna buona: le linee condividono pochi numeri.';
  if (cover.maxOverlap >= 3) quality = 'Copertura più concentrata: alcune linee condividono almeno 3 numeri.';
  if (cover.uniqueNumbers === tickets.length * 6) quality = 'Copertura interna massima: nessun numero è duplicato tra le linee.';
  byId('coverageDetail').innerHTML = '<b>' + escapeHtml(quality) + '</b><br>' +
    '<span class="small muted">Indice basato su numeri e coppie distinti all’interno del portafoglio; non è una probabilità di vincita.</span>';
}

function renderCompare() {
  const target = byId('lastCompare');
  const record = diary.slice().reverse().find(function (item) {
    return item.resultDate && Array.isArray(item.shadowDist);
  });
  if (!record) {
    target.textContent = 'Nessun confronto completo. Le nuove proposte verranno confrontate con 1.000 portafogli casuali equivalenti.';
    return;
  }

  const cells = record.shadowDist.map(function (count, hitCount) {
    return '<div class="compare-cell"><b>' + count + '</b><span>best ' + hitCount + '</span></div>';
  }).join('');

  let verdict = '<b>nella fascia centrale del campione casuale</b>';
  if (Number(record.percentile) >= 60) verdict = '<b class="positive">sopra il campione casuale</b>';
  if (Number(record.percentile) <= 40) verdict = '<b class="warning-text">sotto il campione casuale</b>';

  const lineHits = Array.isArray(record.lineHits) ? record.lineHits : [Number(record.hits) || 0];
  const lineResult = lineHits.map(function (value, index) { return 'L' + (index + 1) + ': ' + value + '/6'; }).join(' · ');

  target.innerHTML = '<b>Estrazione ' + escapeHtml(record.resultDate) + '</b><br>' +
    'Estratti: ' + (record.draw || []).map(Number).join(' · ') + '<br>' +
    'Portafoglio: <b>best ' + Number(record.bestHits != null ? record.bestHits : record.hits || 0) + '/6</b> · ' + escapeHtml(lineResult) +
    '<div class="compare-grid">' + cells + '</div>' +
    '<div>Percentile combinato: <b>' + Number(record.percentile) + '°</b> · ' + verdict + '</div>' +
    '<div class="small muted">Ogni casella indica quanti dei 1.000 portafogli casuali hanno avuto quel miglior risultato tra le loro linee.</div>';
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

  const averageBest = evaluated.reduce(function (sum, record) {
    return sum + (Number(record.bestHits != null ? record.bestHits : record.hits) || 0);
  }, 0) / evaluated.length;
  const averagePercentile = evaluated.reduce(function (sum, record) {
    return sum + Number(record.percentile);
  }, 0) / evaluated.length;
  const zeroPortfolios = evaluated.filter(function (record) { return Number(record.totalHits || 0) === 0; }).length;
  const twoPlus = evaluated.filter(function (record) {
    return Number(record.bestHits != null ? record.bestHits : record.hits) >= 2;
  }).length;
  const standardError = 28.87 / Math.sqrt(evaluated.length);
  const low = Math.max(0, averagePercentile - 1.96 * standardError);
  const high = Math.min(100, averagePercentile + 1.96 * standardError);

  let verdict;
  if (evaluated.length < 25) {
    verdict = '<b class="warning-text">Campione reale ancora piccolo: nessun verdetto affidabile.</b>';
  } else if (low > 50) {
    verdict = '<b class="positive">Segnale sopra il confronto casuale, da continuare a verificare.</b>';
  } else if (high < 50) {
    verdict = '<b class="negative">Portafogli reali inferiori al confronto casuale.</b>';
  } else {
    verdict = '<b>Risultati compatibili con il caso.</b>';
  }

  target.innerHTML = verdict + '<br>' +
    'Portafogli confrontabili: ' + evaluated.length +
    ' · best medio: ' + averageBest.toFixed(2) +
    ' · almeno un 2+: ' + twoPlus +
    ' · zero centri su tutte le linee: ' + zeroPortfolios +
    ' · percentile medio: ' + averagePercentile.toFixed(1) + '°' +
    ' · intervallo 95% circa: ' + low.toFixed(1) + '–' + high.toFixed(1) + '.<br>' +
    '<span class="small muted">Il confronto include anche i portafogli non giocati, così il risultato non viene selezionato a posteriori.</span>';
}

function pct(value, total) {
  return total ? (100 * value / total).toFixed(1) + '%' : '—';
}

function holdoutLine(pair, count) {
  if (!pair || !pair.algorithm || !pair.random) return '';
  const a = pair.algorithm;
  const r = pair.random;
  const label = count + (count === 1 ? ' linea' : ' linee');
  const diff = a.any2plus - r.any2plus;
  const cls = diff > 0 ? 'positive' : diff < 0 ? 'negative' : '';
  return '<tr><td>' + label + '</td>' +
    '<td>' + a.any2plus + ' (' + pct(a.any2plus, a.n) + ')</td>' +
    '<td>' + r.any2plus + ' (' + pct(r.any2plus, r.n) + ')</td>' +
    '<td class="' + cls + '">' + (diff > 0 ? '+' : '') + diff + '</td>' +
    '<td>' + a.zeroTotal + '</td><td>' + r.zeroTotal + '</td></tr>';
}

function renderModel() {
  const target = byId('lab');
  if (!model) {
    target.textContent = 'Analisi non eseguita.';
    return;
  }
  if (model.version !== MODEL_VERSION) {
    target.innerHTML = '<b>Modello precedente rilevato.</b> Esegui “Analizza tutto” per creare il backtest V6.';
    return;
  }

  const holdout = model.holdout || {};
  const rows = [1, 2, 4].map(function (count) { return holdoutLine(holdout[String(count)], count); }).join('');
  const validationDiff = Number(model.validation && model.validation.any2plus || 0) - Number(model.randomValidation && model.randomValidation.any2plus || 0);

  target.innerHTML = '<b>Modello selezionato:</b> ' + escapeHtml(model.weights.name) + '.<br>' +
    'Validazione: ' + Number(model.validationN) + ' concorsi (' + escapeHtml(model.validationStart) + ' → ' + escapeHtml(model.validationEnd) + '). ' +
    'A 4 linee: almeno un 2+ algoritmo ' + Number(model.validation && model.validation.any2plus || 0) + ' vs casuale ' + Number(model.randomValidation && model.randomValidation.any2plus || 0) +
    ' (' + (validationDiff > 0 ? '+' : '') + validationDiff + ').<br>' +
    'Holdout mai usato nella scelta: ' + Number(model.holdoutN) + ' concorsi (' + escapeHtml(model.holdoutStart) + ' → ' + escapeHtml(model.holdoutEnd) + ').' +
    '<div class="scroll"><table class="mini-table"><thead><tr><th>Portafoglio</th><th>Algoritmo 2+</th><th>Casuale 2+</th><th>Δ</th><th>Zero alg.</th><th>Zero cas.</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="small muted">“2+” significa almeno una linea con 2 o più numeri. “Zero” significa nessun numero centrato in nessuna linea del portafoglio.</div>';
}

function realizedMoney() {
  const cash = diary.filter(function (record) { return record.played === true; });
  const spent = cash.reduce(function (sum, record) {
    return sum + (Number(record.cost) || TICKET_COST);
  }, 0);
  const settled = cash.filter(function (record) {
    if (!record.resultDate) return false;
    if (playedPrizeThreshold(record) < 2) return true;
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
    return record.resultDate && playedPrizeThreshold(record) >= 2 && (record.returnAmount == null || record.returnAmount === '');
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
  if (!stats.cash.length) messages.push('Nessun portafoglio è ancora conteggiato come spesa.');
  if (stats.pendingDraws) messages.push(stats.pendingDraws + ' giocata/e attendono l’estrazione.');
  if (stats.missingPrizes) messages.push('Inserisci l’incasso di ' + stats.missingPrizes + ' giocata/e con almeno un 2+ per completare il ROI.');
  if (stats.settledSpent) messages.push('Profitto e ROI usano soltanto giocate già definite.');
  byId('moneyStatus').textContent = messages.join(' ');
}

function returnField(record) {
  if (record.played !== true || !record.resultDate) return '—';
  if (playedPrizeThreshold(record) < 2) return formatMoney(0);
  const value = record.returnAmount == null ? '' : Number(record.returnAmount).toFixed(2);
  return '<input data-field="return" data-id="' + escapeHtml(record.id) + '" type="number" min="0" step="0.01" inputmode="decimal" value="' + escapeHtml(value) + '" placeholder="€ 0,00" aria-label="Incasso effettivo">';
}

function diaryPortfolioText(record) {
  const tickets = normalizeTickets(record);
  return tickets.map(function (ticket, index) {
    return 'L' + (index + 1) + ': ' + ticket.join(' ');
  }).join(' / ');
}

function diaryState(record) {
  if (record.played === true) return 'Giocate ' + Number(record.playedLines || 1) + ' · ' + formatMoney(record.cost);
  if (record.played === false) return 'Solo test';
  return record.resultDate ? 'Non confermata' : 'Da confermare';
}

function renderDiary() {
  const target = byId('diary');
  if (!diary.length) {
    target.innerHTML = '<div class="status">Nessun portafoglio registrato.</div>';
    return;
  }

  const rows = diary.slice().reverse().map(function (record) {
    const result = record.resultDate ? escapeHtml(record.resultDate) + (record.legacySameDay ? '*' : '') : 'in attesa';
    const best = record.resultDate ? Number(record.bestHits != null ? record.bestHits : record.hits || 0) + '/6' : '—';
    const playedBest = record.resultDate && record.played === true ? Number(record.playedBestHits || 0) + '/6 giocato' : '';
    const percentile = record.percentile == null ? '—' : Number(record.percentile) + '°';
    const cost = record.played === true ? formatMoney(record.cost || TICKET_COST) : formatMoney(0);
    return '<tr>' +
      '<td>' + escapeHtml(record.generatedDate || '') + '</td>' +
      '<td class="portfolio-cell"><b>' + escapeHtml(diaryPortfolioText(record)) + '</b></td>' +
      '<td>' + escapeHtml(diaryState(record)) + '</td>' +
      '<td>' + result + '</td>' +
      '<td>' + best + (playedBest ? '<div class="small muted">' + playedBest + '</div>' : '') + '</td>' +
      '<td>' + percentile + '</td>' +
      '<td>' + cost + '</td>' +
      '<td>' + returnField(record) + '</td>' +
      '</tr>';
  }).join('');

  const legacyNote = diary.some(function (record) { return record.legacySameDay; })
    ? '<div class="small muted">* Proposta di una versione precedente, abbinata all’estrazione dello stesso giorno perché il vecchio formato non salvava il concorso di riferimento.</div>'
    : '';

  target.innerHTML = '<table class="diary-table"><thead><tr>' +
    '<th>Creata</th><th>Portafoglio</th><th>Stato</th><th>Estrazione</th><th>Best</th><th>vs 1.000</th><th>Costo</th><th>Incasso €</th>' +
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
    ? (evaluated.reduce(function (sum, record) {
      return sum + (Number(record.bestHits != null ? record.bestHits : record.hits) || 0);
    }, 0) / evaluated.length).toFixed(2)
    : '—';

  renderCoverage();
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
    'generata', 'portafoglio', 'linee_giocate', 'stato', 'estrazione', 'estratti', 'best_portafoglio', 'best_giocato', 'percentile', 'costo', 'incasso', 'profitto'
  ];
  const rows = diary.map(function (record) {
    const state = record.played === true ? 'giocata' : record.played === false ? 'solo test' : 'da confermare';
    const cost = record.played === true ? Number(record.cost) || TICKET_COST : 0;
    const hasReturn = record.returnAmount !== '' && record.returnAmount != null && Number.isFinite(Number(record.returnAmount));
    const amount = hasReturn ? Number(record.returnAmount) : '';
    const profit = record.played === true && record.resultDate && (playedPrizeThreshold(record) < 2 || hasReturn)
      ? Number(amount || 0) - cost
      : '';
    return [
      record.generatedDate,
      diaryPortfolioText(record),
      record.played === true ? Number(record.playedLines || 1) : 0,
      state,
      record.resultDate || '',
      (record.draw || []).join(' '),
      record.bestHits == null ? (record.hits == null ? '' : record.hits) : record.bestHits,
      record.playedBestHits == null ? '' : record.playedBestHits,
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
  link.download = 'superenalotto_v60_diario.csv';
  link.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 0);
}

function resetDiary() {
  if (!window.confirm('Cancellare tutto il diario, comprese conferme di spesa e incassi?')) return;
  diary = [];
  localStorage.removeItem(DIARY_STORE);
  byId('ticketBox').innerHTML = '';
  render();
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
  if (button.dataset.ticketAction === 'play') {
    setPlayState(button.dataset.id, true, Number(button.dataset.lines) || 1);
  } else if (button.dataset.ticketAction === 'test') {
    setPlayState(button.dataset.id, false, 0);
  }
}

function onBudgetChange() {
  const value = clamp(Math.round(Number(byId('monthlyBudget').value) || DEFAULT_BUDGET), 1, 100);
  monthlyBudget = value;
  byId('monthlyBudget').value = value;
  saveBudget();
  renderMoney();
  const reference = currentReference();
  const pendingRecord = pendingForReference(reference);
  if (pendingRecord) renderTicket(pendingRecord);
}

byId('bUpdate').addEventListener('click', easyUpdate);
byId('bAnalyze').addEventListener('click', easyAnalyze);
byId('bGenerate').addEventListener('click', easyGenerate);
byId('exportBtn').addEventListener('click', exportDiary);
byId('resetBtn').addEventListener('click', resetDiary);
byId('monthlyBudget').addEventListener('change', onBudgetChange);
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
  setUI('APP INSTALLATA', 'La scorciatoia usa ora la V6.', 100, false);
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
