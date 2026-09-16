'use strict';

(() => {
  const DRAW_STORE = 'se_v31_archive';
  const MODEL_STORE = 'se_v6_model';
  const DIARY_STORE = 'se_v5_diary';
  const POOL_SIZE = 18;
  const HISTORY_LIMIT = 900;
  const PAIR_WINDOW = 360;

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

  function combinations(values, k, callback) {
    const picked = Array(k);
    function walk(start, depth) {
      if (depth === k) {
        callback(picked.slice());
        return;
      }
      const remaining = k - depth;
      for (let i = start; i <= values.length - remaining; i += 1) {
        picked[depth] = values[i];
        walk(i + 1, depth + 1);
      }
    }
    walk(0, 0);
  }

  function frequency(history, windowSize) {
    const rows = history.slice(-windowSize);
    const counts = Array(91).fill(0);
    rows.forEach((draw) => (draw.nums || []).forEach((n) => {
      const value = Number(n);
      if (value >= 1 && value <= 90) counts[value] += 1;
    }));
    return { counts, total: rows.length };
  }

  function lastSeen(history) {
    const last = Array(91).fill(-1);
    history.forEach((draw, index) => (draw.nums || []).forEach((n) => {
      const value = Number(n);
      if (value >= 1 && value <= 90) last[value] = index;
    }));
    return last;
  }

  function normalizedFrequency(count, draws) {
    if (!draws) return 0;
    const expected = draws * 6 / 90;
    const variance = Math.max(0.001, draws * (6 / 90) * (84 / 90));
    return clamp((count - expected) / Math.sqrt(variance), -2.5, 2.5) / 2.5;
  }

  function guardInfo(model) {
    const holdout = model && model.holdout && model.holdout['1'];
    const algorithm = holdout && holdout.algorithm;
    const random = holdout && holdout.random;
    const holdoutEdge = algorithm && random
      ? Number(algorithm.any2plus || 0) - Number(random.any2plus || 0)
      : -999;
    const zeroEdge = algorithm && random
      ? Number(random.zeroTotal || 0) - Number(algorithm.zeroTotal || 0)
      : -999;
    const passes = Boolean(model && model.version === 'V6.0' && model.weights && holdoutEdge >= 0 && zeroEdge >= 0);
    return {
      accepted: passes,
      holdoutEdge,
      zeroEdge,
      freqWeight: passes ? clamp(Number(model.weights.freq || 0) * 0.55, 0, 0.28) : 0.06,
      delayWeight: passes ? clamp(Number(model.weights.delay || 0) * 0.45, 0, 0.16) : 0.03
    };
  }

  function numberSignals(history, model) {
    const short = frequency(history, Math.min(36, history.length));
    const medium = frequency(history, Math.min(120, history.length));
    const long = frequency(history, Math.min(360, history.length));
    const full = frequency(history, history.length);
    const last = lastSeen(history);
    const guard = guardInfo(model);
    const score = Array(91).fill(0);
    const details = Array(91).fill(null);

    for (let n = 1; n <= 90; n += 1) {
      const zShort = normalizedFrequency(short.counts[n], short.total);
      const zMedium = normalizedFrequency(medium.counts[n], medium.total);
      const zLong = normalizedFrequency(long.counts[n], long.total);
      const zFull = normalizedFrequency(full.counts[n], full.total);
      const gap = last[n] < 0 ? 15 : Math.max(0, history.length - 1 - last[n]);
      const delay = clamp((gap - 14) / 42, -1, 1);
      const stability = 1 - clamp(Math.abs(zShort - zMedium) / 2, 0, 1);
      const neutral = 1 - clamp(Math.abs(zFull), 0, 1);
      const trend = zShort * 0.45 + zMedium * 0.35 + zLong * 0.20;
      const antiCrowd = n <= 31 ? -0.025 : 0.012;

      const raw =
        1 +
        guard.freqWeight * trend +
        guard.delayWeight * delay +
        0.045 * stability +
        0.025 * neutral +
        antiCrowd;

      score[n] = Math.max(0.55, raw);
      details[n] = { zShort, zMedium, zLong, zFull, gap, stability, neutral, raw: score[n] };
    }

    return { score, details, guard };
  }

  function pairMap(history) {
    const rows = history.slice(-Math.min(PAIR_WINDOW, history.length));
    const pairs = new Map();
    rows.forEach((draw) => {
      const nums = (draw.nums || []).map(Number).sort((a, b) => a - b);
      for (let i = 0; i < nums.length; i += 1) {
        for (let j = i + 1; j < nums.length; j += 1) {
          const key = nums[i] + '-' + nums[j];
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      }
    });
    let max = 1;
    pairs.forEach((value) => { max = Math.max(max, value); });
    return { pairs, max };
  }

  function historicalShape(history) {
    const rows = history.slice(-Math.min(500, history.length));
    const sums = [];
    const odds = [];
    const lows = [];
    const decades = [];
    rows.forEach((draw) => {
      const nums = (draw.nums || []).map(Number).sort((a, b) => a - b);
      if (nums.length !== 6) return;
      sums.push(nums.reduce((a, b) => a + b, 0));
      odds.push(nums.filter((n) => n % 2 === 1).length);
      lows.push(nums.filter((n) => n <= 45).length);
      decades.push(new Set(nums.map((n) => Math.floor((n - 1) / 10))).size);
    });
    const mean = (arr, fallback) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : fallback;
    const sd = (arr, m, fallback) => arr.length > 1
      ? Math.sqrt(arr.reduce((sum, value) => sum + Math.pow(value - m, 2), 0) / (arr.length - 1))
      : fallback;
    const sumMean = mean(sums, 273);
    return {
      sumMean,
      sumSd: Math.max(22, sd(sums, sumMean, 55)),
      oddMean: mean(odds, 3),
      lowMean: mean(lows, 3),
      decadeMean: mean(decades, 4.7)
    };
  }

  function consecutiveCount(ticket) {
    let count = 0;
    for (let i = 1; i < ticket.length; i += 1) if (ticket[i] === ticket[i - 1] + 1) count += 1;
    return count;
  }

  function ticketScore(ticket, signals, pairs, shape) {
    const numberComponent = ticket.reduce((sum, n) => sum + Math.log(signals.score[n]), 0);
    let pairComponent = 0;
    for (let i = 0; i < ticket.length; i += 1) {
      for (let j = i + 1; j < ticket.length; j += 1) {
        const key = ticket[i] + '-' + ticket[j];
        pairComponent += (pairs.pairs.get(key) || 0) / pairs.max;
      }
    }
    pairComponent /= 15;

    const sum = ticket.reduce((a, b) => a + b, 0);
    const odd = ticket.filter((n) => n % 2 === 1).length;
    const low = ticket.filter((n) => n <= 45).length;
    const decades = new Set(ticket.map((n) => Math.floor((n - 1) / 10))).size;
    const consecutive = consecutiveCount(ticket);

    const sumFit = Math.exp(-0.5 * Math.pow((sum - shape.sumMean) / shape.sumSd, 2));
    const oddFit = Math.exp(-0.65 * Math.pow(odd - shape.oddMean, 2));
    const lowFit = Math.exp(-0.65 * Math.pow(low - shape.lowMean, 2));
    const decadeFit = Math.exp(-0.55 * Math.pow(decades - shape.decadeMean, 2));
    const consecutivePenalty = consecutive <= 1 ? 0 : (consecutive - 1) * 0.11;

    const structural = 0.19 * sumFit + 0.10 * oddFit + 0.10 * lowFit + 0.08 * decadeFit;
    return numberComponent + 0.12 * pairComponent + structural - consecutivePenalty;
  }

  function lexicographicLess(a, b) {
    if (!b) return true;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  function selectDeterministicTicket(history, model) {
    const signals = numberSignals(history, model);
    const pairStats = pairMap(history);
    const shape = historicalShape(history);
    const pool = Array.from({ length: 90 }, (_unused, index) => index + 1)
      .sort((a, b) => signals.score[b] - signals.score[a] || a - b)
      .slice(0, POOL_SIZE)
      .sort((a, b) => a - b);

    let bestTicket = null;
    let bestScore = -Infinity;
    combinations(pool, 6, (ticket) => {
      const score = ticketScore(ticket, signals, pairStats, shape);
      if (score > bestScore + 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && lexicographicLess(ticket, bestTicket))) {
        bestScore = score;
        bestTicket = ticket;
      }
    });

    const rankedPool = pool.slice().sort((a, b) => signals.score[b] - signals.score[a] || a - b);
    return {
      ticket: bestTicket || rankedPool.slice(0, 6).sort((a, b) => a - b),
      pool: rankedPool,
      score: bestScore,
      signals
    };
  }

  function coverage(ticket) {
    return { uniqueNumbers: 6, uniquePairs: 15, maxOverlap: 0, score: 100 };
  }

  function setStatus(main, sub) {
    const status = document.getElementById('mainStatus');
    const detail = document.getElementById('mainSub');
    const bar = document.getElementById('mainBar');
    if (status) status.textContent = main;
    if (detail) detail.textContent = sub || '';
    if (bar) bar.style.width = '100%';
  }

  function createRecord() {
    const draws = readJson(DRAW_STORE, []);
    const model = readJson(MODEL_STORE, null);
    let diary = readJson(DIARY_STORE, []);
    if (!Array.isArray(draws) || draws.length < 200 || !model || model.version !== 'V6.0') return false;
    if (!Array.isArray(diary)) diary = [];

    const ordered = draws.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const lastDraw = ordered[ordered.length - 1];
    if (!lastDraw || !lastDraw.date) return false;

    const existingIndex = diary.findIndex((record) => !record.resultDate && record.afterDrawDate === lastDraw.date);
    if (existingIndex >= 0) {
      const existing = diary[existingIndex];
      if (String(existing.model || '').includes('V6.2')) return false;
      if (existing.played === true) {
        setStatus('GIOCATA GIÀ CONFERMATA', 'La proposta precedente per questo concorso è già stata segnata come giocata: non viene sostituita.');
        return true;
      }
      diary.splice(existingIndex, 1);
    }

    const history = ordered.slice(-HISTORY_LIMIT);
    const selected = selectDeterministicTicket(history, model);
    const now = new Date();
    const generatedAt = now.toISOString();
    const ticket = selected.ticket;
    const guard = selected.signals.guard;
    const mode = guard.accepted ? 'V6.2 deterministica · modello validato' : 'V6.2 deterministica · profilo prudente';
    const deterministicSeed = hashSeed(lastDraw.date + '-' + ticket.join('-') + '-v62-shadow');

    const record = {
      id: 'g' + Date.now(),
      generatedAt,
      generatedDate: localDate(now),
      afterDrawDate: lastDraw.date,
      afterContest: lastDraw.contest || null,
      ticket,
      tickets: [ticket],
      portfolioSize: 1,
      pool: selected.pool,
      coverage: coverage(ticket),
      seed: deterministicSeed,
      shadowSeed: (deterministicSeed ^ 0x9e3779b9) >>> 0,
      model: mode,
      engineGuard: {
        acceptedStatisticalModel: guard.accepted,
        holdoutEdge: guard.holdoutEdge,
        zeroEdge: guard.zeroEdge,
        deterministic: true,
        finalScore: Number.isFinite(selected.score) ? Number(selected.score.toFixed(6)) : null
      },
      played: null,
      playedLines: 0,
      cost: 0,
      returnAmount: null
    };

    diary.push(record);
    localStorage.setItem(DIARY_STORE, JSON.stringify(diary));
    setStatus(
      'SESTINA V6.2 GENERATA',
      ticket.join(' · ') + ' · scelta deterministica su ' + selected.pool.length + ' candidati, senza randomizzazione finale.'
    );
    return true;
  }

  function interceptGenerate(event) {
    const button = event.target.closest && event.target.closest('#bGenerate');
    if (!button) return;
    const draws = readJson(DRAW_STORE, []);
    const model = readJson(MODEL_STORE, null);
    if (!Array.isArray(draws) || !draws.length || !model || model.version !== 'V6.0') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (createRecord()) window.setTimeout(() => window.location.reload(), 160);
  }

  function addBadge() {
    const title = document.querySelector('.title');
    if (!title || title.querySelector('[data-v62-badge]')) return;
    const badge = document.createElement('span');
    badge.dataset.v62Badge = '1';
    badge.style.cssText = 'display:inline-block;margin-left:8px;padding:4px 7px;border:1px solid rgba(85,221,160,.35);border-radius:999px;font-size:.33em;vertical-align:middle;color:#55dda0;letter-spacing:0';
    badge.textContent = 'SINGLE 6.2';
    title.appendChild(badge);
  }

  function normalizeSingleUi() {
    const box = document.getElementById('ticketBox');
    if (box) {
      box.querySelectorAll('h3,.ticket-note,.muted.small').forEach((node) => {
        node.textContent = node.textContent
          .replace('Portafoglio V6 · 4 linee', 'Sestina V6.2 · 1 linea')
          .replace('Le 4 linee restano nel diario anche se ne giochi soltanto una.', 'La sestina resta nel diario anche se scegli di non giocarla.')
          .replace('Portafoglio', 'Sestina');
      });
    }
  }

  function installUiObserver() {
    normalizeSingleUi();
    const box = document.getElementById('ticketBox');
    if (!box || box.dataset.v62Observed) return;
    box.dataset.v62Observed = '1';
    new MutationObserver(normalizeSingleUi).observe(box, { childList: true, subtree: true });
  }

  document.addEventListener('click', interceptGenerate, true);
  window.addEventListener('load', () => { addBadge(); installUiObserver(); });
})();
