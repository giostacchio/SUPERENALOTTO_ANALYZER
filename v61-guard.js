'use strict';

(() => {
  const DRAW_STORE = 'se_v31_archive';
  const MODEL_STORE = 'se_v6_model';
  const DIARY_STORE = 'se_v5_diary';
  const PORTFOLIO_SIZE = 4;
  const POOL_SIZE = 18;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  function localDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
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

  function mulberry32(seed) {
    return function () {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function buildStats(history) {
    const count = Array(91).fill(0);
    const last = Array(91).fill(-1);
    history.forEach((draw, index) => {
      (draw.nums || []).forEach((n) => {
        const value = Number(n);
        if (value >= 1 && value <= 90) {
          count[value] += 1;
          last[value] = index;
        }
      });
    });
    return { total: history.length, count, last };
  }

  function guardedWeights(model) {
    const validation = model && model.validation;
    const randomValidation = model && model.randomValidation;
    const holdoutPair = model && model.holdout && model.holdout['4'];
    const algo = holdoutPair && holdoutPair.algorithm;
    const random = holdoutPair && holdoutPair.random;

    const validationEdge = validation && randomValidation
      ? Number(validation.any2plus || 0) - Number(randomValidation.any2plus || 0)
      : -999;
    const holdoutEdge = algo && random
      ? Number(algo.any2plus || 0) - Number(random.any2plus || 0)
      : -999;
    const zeroEdge = algo && random
      ? Number(random.zeroTotal || 0) - Number(algo.zeroTotal || 0)
      : -999;

    const passes = Boolean(
      model && model.version === 'V6.0' && model.weights &&
      validationEdge >= 0 &&
      holdoutEdge >= 0 &&
      zeroEdge >= 0
    );

    if (!passes) {
      return {
        mode: 'Copertura neutra V6.1',
        accepted: false,
        validationEdge,
        holdoutEdge,
        zeroEdge,
        weights: { freq: 0, delay: 0, anti: 0 }
      };
    }

    return {
      mode: 'Statistica attenuata V6.1',
      accepted: true,
      validationEdge,
      holdoutEdge,
      zeroEdge,
      weights: {
        freq: Number(model.weights.freq || 0) * 0.35,
        delay: Number(model.weights.delay || 0) * 0.35,
        anti: Number(model.weights.anti || 0) * 0.35
      }
    };
  }

  function numberScore(n, stats, weights) {
    if (!stats.total) return 1;
    const expected = Math.max(1, stats.total * 6 / 90);
    const freqRatio = stats.count[n] / expected;
    const freqSignal = clamp(freqRatio - 1, -0.30, 0.30);
    const gap = stats.last[n] < 0 ? 14 : Math.max(0, stats.total - 1 - stats.last[n]);
    const delaySignal = clamp((gap - 14) / 45, -0.30, 0.30);
    const antiSignal = n <= 31 ? -0.05 : 0.02;
    return Math.max(0.35,
      1 +
      Number(weights.freq || 0) * freqSignal +
      Number(weights.delay || 0) * delaySignal +
      Number(weights.anti || 0) * antiSignal
    );
  }

  function baseScores(history, weights) {
    const stats = buildStats(history);
    const scores = Array(91).fill(0);
    for (let n = 1; n <= 90; n += 1) scores[n] = numberScore(n, stats, weights);
    return scores;
  }

  function weightedPick(scores, usage, rng) {
    const selected = [];
    while (selected.length < 6) {
      const pool = [];
      let total = 0;
      for (let n = 1; n <= 90; n += 1) {
        if (selected.includes(n)) continue;
        const used = Number(usage[n] || 0);
        const diversityPenalty = used === 0 ? 1 : used === 1 ? 0.075 : 0.01;
        const score = Math.max(0.0001, Number(scores[n] || 1) * diversityPenalty);
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
    return selected.sort((a, b) => a - b);
  }

  function generatePortfolio(history, weights, rng) {
    const scores = baseScores(history, weights);
    const usage = Array(91).fill(0);
    const tickets = [];
    for (let i = 0; i < PORTFOLIO_SIZE; i += 1) {
      const ticket = weightedPick(scores, usage, rng);
      ticket.forEach((n) => { usage[n] += 1; });
      tickets.push(ticket);
    }
    return { tickets, scores };
  }

  function ticketPairs(ticket) {
    const keys = [];
    for (let i = 0; i < ticket.length; i += 1) {
      for (let j = i + 1; j < ticket.length; j += 1) keys.push(ticket[i] + '-' + ticket[j]);
    }
    return keys;
  }

  function coverage(tickets) {
    const numbers = new Set();
    const pairs = new Set();
    let maxOverlap = 0;
    tickets.forEach((ticket, index) => {
      ticket.forEach((n) => numbers.add(n));
      ticketPairs(ticket).forEach((pair) => pairs.add(pair));
      for (let j = 0; j < index; j += 1) {
        const other = new Set(tickets[j]);
        const overlap = ticket.filter((n) => other.has(n)).length;
        maxOverlap = Math.max(maxOverlap, overlap);
      }
    });
    const score = Math.round(100 * (0.55 * numbers.size / (tickets.length * 6) + 0.45 * pairs.size / (tickets.length * 15)));
    return {
      uniqueNumbers: numbers.size,
      uniquePairs: pairs.size,
      maxOverlap,
      score: clamp(score, 0, 100)
    };
  }

  function topPool(scores) {
    return Array.from({ length: 90 }, (_unused, index) => index + 1)
      .sort((a, b) => Number(scores[b] || 0) - Number(scores[a] || 0) || a - b)
      .slice(0, POOL_SIZE);
  }

  function setStatus(main, sub) {
    const status = document.getElementById('mainStatus');
    const detail = document.getElementById('mainSub');
    const bar = document.getElementById('mainBar');
    if (status) status.textContent = main;
    if (detail) detail.textContent = sub || '';
    if (bar) bar.style.width = '100%';
  }

  function createGuardedRecord() {
    const draws = readJson(DRAW_STORE, []);
    const model = readJson(MODEL_STORE, null);
    const diary = readJson(DIARY_STORE, []);
    if (!Array.isArray(draws) || !draws.length || !model || model.version !== 'V6.0') return false;

    const lastDraw = draws.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).pop();
    if (!lastDraw || !lastDraw.date) return false;

    const existing = Array.isArray(diary) && diary.find((record) => !record.resultDate && record.afterDrawDate === lastDraw.date);
    if (existing) return false;

    const guard = guardedWeights(model);
    const now = new Date();
    const generatedAt = now.toISOString();
    const seed = hashSeed(lastDraw.date + '-' + (lastDraw.contest || '') + '-' + generatedAt + '-v61-guard');
    const rng = mulberry32(seed);
    const history = draws.slice(-900);
    const generated = generatePortfolio(history, guard.weights, rng);
    const cover = coverage(generated.tickets);

    const record = {
      id: 'g' + Date.now(),
      generatedAt,
      generatedDate: localDate(now),
      afterDrawDate: lastDraw.date,
      afterContest: lastDraw.contest || null,
      ticket: generated.tickets[0],
      tickets: generated.tickets,
      portfolioSize: generated.tickets.length,
      pool: topPool(generated.scores),
      coverage: cover,
      seed,
      shadowSeed: (seed ^ 0x9e3779b9) >>> 0,
      model: guard.mode,
      engineGuard: {
        acceptedStatisticalModel: guard.accepted,
        validationEdge: guard.validationEdge,
        holdoutEdge: guard.holdoutEdge,
        zeroEdge: guard.zeroEdge
      },
      played: null,
      playedLines: 0,
      cost: 0,
      returnAmount: null
    };

    const updatedDiary = Array.isArray(diary) ? diary.slice() : [];
    updatedDiary.push(record);
    localStorage.setItem(DIARY_STORE, JSON.stringify(updatedDiary));

    const modeText = guard.accepted
      ? 'Il modello statistico ha superato i controlli: pesi ridotti al 35% per limitare l’overfitting.'
      : 'Il modello non ha battuto il casuale in tutti i controlli: usata copertura neutra.';
    setStatus('PORTAFOGLIO V6.1 GENERATO', cover.uniqueNumbers + ' numeri distinti · ' + modeText);
    return true;
  }

  function interceptGenerate(event) {
    const button = event.target.closest && event.target.closest('#bGenerate');
    if (!button) return;

    const draws = readJson(DRAW_STORE, []);
    const model = readJson(MODEL_STORE, null);
    const diary = readJson(DIARY_STORE, []);
    if (!Array.isArray(draws) || !draws.length || !model || model.version !== 'V6.0') return;

    const lastDraw = draws.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).pop();
    const existing = lastDraw && Array.isArray(diary) && diary.find((record) => !record.resultDate && record.afterDrawDate === lastDraw.date);
    if (existing) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (createGuardedRecord()) {
      window.setTimeout(() => window.location.reload(), 180);
    }
  }

  function addBadge() {
    const title = document.querySelector('.title');
    if (!title || title.querySelector('[data-v61-badge]')) return;
    const badge = document.createElement('span');
    badge.dataset.v61Badge = '1';
    badge.style.cssText = 'display:inline-block;margin-left:8px;padding:4px 7px;border:1px solid rgba(85,221,160,.35);border-radius:999px;font-size:.33em;vertical-align:middle;color:#55dda0;letter-spacing:0';
    badge.textContent = 'GUARD 6.1';
    title.appendChild(badge);
  }

  document.addEventListener('click', interceptGenerate, true);
  window.addEventListener('load', addBadge);
})();
