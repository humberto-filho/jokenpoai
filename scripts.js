// scripts.js — IA adaptativa p/ JokenpoAI
// Recursos: padrões de repetição, transições 1ª/2ª ordem, pós-resultado,
// sinais do mouse (intenção/hesitação), ε-greedy com progressão, e ajuste
// de pesos por desempenho dos preditores (multiplicative weights).
//
// >>> ADIÇÃO: Anti-"aprendizado" do jogador
// Introduz variação diária (por nome + data) nos parâmetros de exploração,
// limiares e pesos, via hash determinístico + PRNG seeded.
//

(() => {
  "use strict";

  // ---------- Util: obter nome do jogador e chave diária ----------
  function getPlayerNameFromContext() {
    try {
      const params = new URLSearchParams(location.search);
      const fromQuery = (params.get("name") || "").trim();
      if (fromQuery) return fromQuery;
      const ls = localStorage.getItem("playerName");
      return (ls || "").trim();
    } catch {
      return "";
    }
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function localYMD(d) {
    // YYYY-MM-DD no fuso local do navegador
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  // Hash de string (xmur3) e PRNG (mulberry32) — curtos e determinísticos
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PLAYER_NAME = getPlayerNameFromContext() || "anon";
  const DAILY_KEY = localYMD(new Date()) + "#" + PLAYER_NAME.toLowerCase();
  const SEED = xmur3(DAILY_KEY)();
  const rng = mulberry32(SEED); // PRNG determinístico p/ gerar variantes

  // ---------- Variantes do dia (RVAR): aleatorizam parâmetros-chave ----------
  function randIn(a, b) { return a + (b - a) * rng(); }
  function randPick(arr) { return arr[Math.floor(rng() * arr.length)]; }

  // Monta multiplicadores por preditor para bagunçar "metagame" diário
  const PREDICTORS = ["freq","hover","trans1","trans2","post","repeat","pivot","ngram"];
  const wMult = {};
  for (const k of PREDICTORS) wMult[k] = randIn(0.85, 1.15); // ±15%

  // Multiplicadores leves na escala de desempenho por preditor (±8%)
  const perfScaleMult = {};
  for (const k of PREDICTORS) perfScaleMult[k] = randIn(0.92, 1.08);

  // Epsilons por nível com ruído controlado
  const eps0 = randIn(0.26, 0.34); // base 0.30 ±0.04
  const eps1 = randIn(0.16, 0.24); // base 0.20 ±0.04
  const eps2 = randIn(0.10, 0.16); // base 0.12 ±0.04
  const eps3 = randIn(0.06, 0.10); // base 0.08 ±0.02

  // Jitter global/por rodada para ε efetivo (pequena respiração)
  const epsGlobalScale = randIn(0.9, 1.1); // ±10%
  function epsilonEffective(baseEps) {
    // Pequena variação por rodada (determinística no dia)
    const perRoundJitter = randIn(0.95, 1.05);
    return Math.max(0.03, Math.min(0.6, baseEps * epsGlobalScale * perRoundJitter));
  }

  // Threshold de "empate técnico" para amostragem proporcional (antes 0.05)
  const tieClose = randIn(0.035, 0.085);

  // Boost do repetidor quando hesitação + derrota (antes 1.6)
  const repeatBoost = randIn(1.4, 1.9);

  // Decaimento de memória (antes 0.92) — ligeiro ruído
  const decayVar = randIn(0.90, 0.96);

  // Hesitação: ruídos nos limiares
  const hesitBaseMsFactor = randIn(0.9, 1.1);   // 700 ms → 630..770 ms
  const hesitMul = randIn(1.15, 1.4);           // 1.25 → 1.15..1.40
  const switchThresh = Math.max(2, Math.round(randIn(2.5, 3.5))); // tipicamente 3
  const pathFactor = randIn(0.85, 1.2);         // 800 px → 680..960 px

  // Pivot: leve aumento de peso se existir
  const pivotBoost = randIn(1.05, 1.25);        // antes *1.2

  const RVAR = {
    epsLevels: [eps0, eps1, eps2, eps3],
    epsGlobalScale,
    epsilonEffective,
    tieClose,
    repeatBoost,
    decayVar,
    wMult,
    perfScaleMult,
    hesitBaseMsFactor,
    hesitMul,
    switchThresh,
    pathFactor,
    pivotBoost,
    // útil p/ depuração:
    stamp: DAILY_KEY,
  };

  // ---------- Constantes gerais ----------
  const TOTAL_ROUNDS = 50;
  const MOVES = {
    tesoura: { label: "Tesoura", emoji: "✂️" },
    pedra:   { label: "Pedra",   emoji: "🪨" },
    papel:   { label: "Papel",   emoji: "📄" },
  };
  const ORDER = ["tesoura", "pedra", "papel"];
  const COUNTER = { tesoura: "pedra", pedra: "papel", papel: "tesoura" };

  // ---------- Estado da sessão (reinicia em reload) ----------
  let roundsPlayed = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;

  // ---------- LocalStorage ----------
  const LS_KEYS = {
    MODEL: "jkp_model",
    HISTORY: "jkp_history",
    TOTALS: "jkp_totals",
  };

  function loadLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function saveLS(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function defaultModel() {
    return {
      roundsSeen: 0,
      level: 0,                        // 0..3
      epsilon: RVAR.epsLevels[0],      // ε do nível 0 já aleatorizado
      decay: RVAR.decayVar,            // memória com ruído diário
      counts: { tesoura: 1, pedra: 1, papel: 1 }, // smoothing
      trans1: { tesoura: {tesoura:1,pedra:1,papel:1},
                pedra:   {tesoura:1,pedra:1,papel:1},
                papel:   {tesoura:1,pedra:1,papel:1} },
      trans2: {},                      // chave "a|b" -> {tesoura:..,pedra:..,papel:..}
      postRes: { win:{tesoura:1,pedra:1,papel:1},
                 lose:{tesoura:1,pedra:1,papel:1},
                 draw:{tesoura:1,pedra:1,papel:1}},
      lastMove: null,
      prevMove: null,
      lastTwoKey: null,                // "a|b"
      lastResult: null,                // "win"/"lose"/"draw"
      streak: 0,                       // streak do MESMO lance
      hesitation: {
        avgDecisionMs: Math.round(700 * RVAR.hesitBaseMsFactor), // base diária
        samples: 0,
        pivot: {
          tesoura: { tesoura:1, pedra:1, papel:1 },
          pedra:   { tesoura:1, pedra:1, papel:1 },
          papel:   { tesoura:1, pedra:1, papel:1 },
        }
      },
      // desempenho dos preditores (0..1 aprox)
      perf: {
        freq: 0.5, trans1: 0.5, trans2: 0.5, post: 0.5,
        repeat: 0.5, hover: 0.5, pivot: 0.5, ngram: 0.5
      },
      // marca do "perfil" do dia (diagnóstico)
      variantStamp: RVAR.stamp,
    };
  }

  let MODEL = loadLS(LS_KEYS.MODEL, defaultModel());
  let TOTALS = loadLS(LS_KEYS.TOTALS, { wins:0, losses:0, draws:0, sessions:0 });

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const hello = $("hello");
  const progressBar = $("progressBar");
  const progressLabel = $("progressLabel");
  const resultEl = $("result");
  const choicesEl = $("choices");
  const resetBtn = $("resetBtn");
  const confirmBox = $("confirmBox");
  const confirmText = $("confirmText");
  const confirmBtn = $("confirmBtn");
  const cancelConfirmBtn = $("cancelConfirmBtn");

  const finalOverlay = $("finalOverlay");
  const finalEmoji = $("finalEmoji");
  const finalTitle = $("finalTitle");
  const finalDesc = $("finalDesc");
  const closeFinalBtn = $("closeFinalBtn");
  const goHomeBtn = $("goHomeBtn");
  const goHomeConfirmBox = $("goHomeConfirmBox");
  const goHomeConfirmText = $("goHomeConfirmText");
  const goHomeCancel = $("goHomeCancel");
  const goHomeConfirm = $("goHomeConfirm");

  const moveButtons = () => document.querySelectorAll("button[data-move]");

  // ---------- Placar (injetado) ----------
  function ensureScoreboardUI() {
    if ($("scoreboard")) return;
    const section = document.createElement("section");
    section.id = "scoreboard";
    section.className = "mb-5";
    section.innerHTML = `
      <div class="rounded-md border bg-card p-3">
        <div class="flex items-center justify-between">
          <span class="text-xs text-muted-foreground">Placar</span>
          <div class="flex items-center gap-2 text-xs">
            <span class="rounded-md border bg-background px-2 py-0.5">Vitórias: <strong id="scoreWins">0</strong></span>
            <span class="rounded-md border bg-background px-2 py-0.5">Empates: <strong id="scoreDraws">0</strong></span>
            <span class="rounded-md border bg-background px-2 py-0.5">Derrotas: <strong id="scoreLosses">0</strong></span>
          </div>
        </div>
      </div>
    `;
    const progressSection = progressBar ? progressBar.closest("section") : null;
    if (progressSection && progressSection.parentNode) {
      progressSection.parentNode.insertBefore(section, progressSection.nextSibling);
    }
  }
  function updateScoreUI() {
    const winsEl = $("scoreWins");
    const drawsEl = $("scoreDraws");
    const lossesEl = $("scoreLosses");
    if (winsEl) winsEl.textContent = wins;
    if (drawsEl) drawsEl.textContent = draws;
    if (lossesEl) lossesEl.textContent = losses;
  }

  // ---------- UI helpers ----------
  function setResultUI(el, result) {
    el.classList.remove(
      "hidden",
      "bg-green-50","border-green-200","text-green-700",
      "bg-red-50","border-red-200","text-red-700",
      "bg-muted","border-input","text-foreground"
    );
    if (result === "win") {
      el.classList.add("bg-green-50","border-green-200","text-green-700");
      el.textContent = "Você ganhou! ✅";
    } else if (result === "lose") {
      el.classList.add("bg-red-50","border-red-200","text-red-700");
      el.textContent = "Você perdeu. ❌";
    } else {
      el.classList.add("bg-muted","border-input","text-foreground");
      el.textContent = "Empate. ⚖️";
    }
  }
  function updateProgressUI() {
    const pct = Math.min((roundsPlayed / TOTAL_ROUNDS) * 100, 100);
    progressBar.style.width = pct + "%";
    progressBar.setAttribute("aria-valuenow", String(roundsPlayed));
    progressLabel.textContent = `${roundsPlayed} / ${TOTAL_ROUNDS}`;
  }
  function setGreeting() {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get("name");
    let name = (fromQuery || "").trim();
    try { if (!name) name = (localStorage.getItem("playerName") || "").trim(); } catch {}
    hello.textContent = name ? `Jogando como ${name}.` : "Escolha sua jogada.";
  }

  // ---------- Sensor de mouse por rodada ----------
  let sensor = null;
  function newSensorRound() {
    const now = performance.now();
    sensor = {
      startAt: now,
      lastAt: now,
      current: null, // "tesoura" | "pedra" | "papel" | null
      hoverMs: { tesoura: 0, pedra: 0, papel: 0 },
      switches: 0,
      moves: 0,
      path: 0,
      lastPos: null,
    };
  }
  function attachHoverListeners() {
    moveButtons().forEach(btn => {
      const move = btn.getAttribute("data-move");

      btn.addEventListener("pointerenter", (e) => {
        if (!sensor) return;
        const now = performance.now();
        if (sensor.current && sensor.current !== move) {
          sensor.hoverMs[sensor.current] += (now - sensor.lastAt);
          sensor.switches += 1;
        }
        sensor.current = move;
        sensor.lastAt = now;
      });

      btn.addEventListener("pointerleave", () => {
        if (!sensor) return;
        const now = performance.now();
        if (sensor.current) {
          sensor.hoverMs[sensor.current] += (now - sensor.lastAt);
        }
        sensor.current = null;
        sensor.lastAt = now;
      });

      btn.addEventListener("pointermove", (e) => {
        if (!sensor) return;
        sensor.moves += 1;
        const p = { x: e.clientX, y: e.clientY };
        if (sensor.lastPos) {
          const dx = p.x - sensor.lastPos.x;
          const dy = p.y - sensor.lastPos.y;
          sensor.path += Math.hypot(dx, dy);
        }
        sensor.lastPos = p;
      });
    });

    document.addEventListener("pointerdown", () => {
      if (!sensor) return;
      const now = performance.now();
      if (sensor.current) sensor.hoverMs[sensor.current] += (now - sensor.lastAt);
      sensor.lastAt = now;
    }, { capture: true });
  }

  // ---------- Preditores ----------
  function zeroDist() { return { tesoura: 0, pedra: 0, papel: 0 }; }
  function uniformDist() { return { tesoura: 1/3, pedra: 1/3, papel: 1/3 }; }
  function normDist(d) {
    let s = d.tesoura + d.pedra + d.papel;
    if (s <= 1e-9) return uniformDist();
    return { tesoura: d.tesoura/s, pedra: d.pedra/s, papel: d.papel/s };
  }
  function addWeighted(acc, d, w) {
    acc.tesoura += (d.tesoura || 0) * w;
    acc.pedra   += (d.pedra   || 0) * w;
    acc.papel   += (d.papel   || 0) * w;
  }
  function distFromCounts(obj) {
    return normDist({ tesoura: obj.tesoura || 0, pedra: obj.pedra || 0, papel: obj.papel || 0 });
  }

  // Frequência global
  function predFreq() { return distFromCounts(MODEL.counts); }

  // Transição 1ª ordem: P(next | lastMove)
  function predTrans1() {
    if (!MODEL.lastMove) return null;
    return distFromCounts(MODEL.trans1[MODEL.lastMove] || {});
  }

  // Transição 2ª ordem: P(next | lastTwo)
  function predTrans2() {
    if (!MODEL.lastTwoKey) return null;
    return distFromCounts(MODEL.trans2[MODEL.lastTwoKey] || {});
  }

  // Pós-resultado (heurística win-stay / lose-shift)
  function predPostRes() {
    if (!MODEL.lastResult) return null;
    return distFromCounts(MODEL.postRes[MODEL.lastResult] || {});
  }

  // Repetição / anti-repetição a partir do streak e comportamento recente
  function predRepeat() {
    if (!MODEL.lastMove) return null;
    const d = zeroDist();
    if (MODEL.lastResult === "win") {
      d[MODEL.lastMove] = 1;
    } else if (MODEL.lastResult === "lose") {
      d[MODEL.lastMove] = 0.4;
      d[COUNTER[MODEL.lastMove]] = 0.6;
    } else {
      d[MODEL.lastMove] = 0.55;
    }
    if (MODEL.streak >= 2) d[MODEL.lastMove] += 0.5;
    return normDist(d);
  }

  // N-gram curto: ABAB / ABCABC nos últimos 4~6 lances
  function predNgram(history) {
    if (!history || history.length < 4) return null;
    const last = history.slice(-6).map(h => h.player);
    const d = zeroDist();

    // ABAB?
    if (last.length >= 4) {
      const a = last[last.length-4], b = last[last.length-3], c = last[last.length-2], d2 = last[last.length-1];
      if (a && b && c && d2 && a === c && b === d2 && a !== b) d[a] += 1.0;
    }
    // ABCABC?
    if (last.length >= 6) {
      const a = last[last.length-6], b = last[last.length-5], c = last[last.length-4];
      const a2 = last[last.length-3], b2 = last[last.length-2], c2 = last[last.length-1];
      if (a===a2 && b===b2 && c===c2 && a && b && c) d[a] += 0.8;
    }
    const nd = normDist(d);
    if (nd.tesoura === 1/3 && nd.pedra === 1/3 && nd.papel === 1/3) return null;
    return nd;
  }

  // Intenção por hover (sem hesitação): distribuição proporcional ao tempo de hover
  function predHoverIntent(snap) {
    const sum = snap.hoverMs.tesoura + snap.hoverMs.pedra + snap.hoverMs.papel;
    if (sum <= 0) return null;
    return normDist({
      tesoura: snap.hoverMs.tesoura,
      pedra:   snap.hoverMs.pedra,
      papel:   snap.hoverMs.papel
    });
  }

  // Hesitação com limiares aleatorizados por dia/nome
  function isHesitant(snap, decisionMs) {
    const base = MODEL.hesitation.avgDecisionMs;
    const slow = decisionMs > Math.max(700 * RVAR.hesitBaseMsFactor, base * RVAR.hesitMul);
    const manySwitches = snap.switches >= RVAR.switchThresh;
    const longPath = snap.path > 800 * RVAR.pathFactor; // pixels
    return slow || manySwitches || longPath;
  }
  function predPivotFromHesitation(snap, hesitant) {
    if (!hesitant) return null;
    const most = ["tesoura","pedra","papel"].reduce((best, k) =>
      snap.hoverMs[k] > (snap.hoverMs[best] || 0) ? k : best, "tesoura");
    const dist = MODEL.hesitation.pivot[most] || { tesoura:1, pedra:1, papel:1 };
    return distFromCounts(dist);
  }

  // ---------- Combinação de preditores ----------
  function levelWeights(level) {
    // pesos base por nível (soma não precisa dar 1; normalizamos no final)
    let base;
    if (level <= 0) base = { freq:0.30, hover:0.20, trans1:0,    trans2:0,    post:0,    repeat:0,   pivot:0,    ngram:0,    eps:RVAR.epsLevels[0] };
    else if (level === 1) base = { freq:0.25, hover:0.20, trans1:0.30, trans2:0,    post:0.15, repeat:0.10, pivot:0.05, ngram:0.05, eps:RVAR.epsLevels[1] };
    else if (level === 2) base = { freq:0.20, hover:0.10, trans1:0.25, trans2:0.20, post:0.10, repeat:0.15, pivot:0.10, ngram:0.10, eps:RVAR.epsLevels[2] };
    else                  base = { freq:0.15, hover:0.08, trans1:0.20, trans2:0.25, post:0.10, repeat:0.20, pivot:0.12, ngram:0.15, eps:RVAR.epsLevels[3] };
    // aplica multiplicadores diários por preditor (anti-meta)
    for (const k of PREDICTORS) base[k] = (base[k] || 0) * RVAR.wMult[k];
    return base;
  }

  function predictorPerfScale(name) {
    // escala 0.6~1.4 aproximada, com leve ruído por preditor
    const p = MODEL.perf[name] ?? 0.5;
    const base = 0.6 + 1.6 * Math.max(0, Math.min(1, p));
    return base * (RVAR.perfScaleMult[name] || 1);
  }

  function predictNextPlayerDist(snap, decisionMs, history) {
    const hesitant = isHesitant(snap, decisionMs);
    const L = MODEL.level;
    const baseW = levelWeights(L);

    // Boost dinâmico do repetidor quando hesitação + derrota
    let repeatW = baseW.repeat;
    if (decisionMs > Math.max(700 * RVAR.hesitBaseMsFactor, MODEL.hesitation.avgDecisionMs * RVAR.hesitMul) && MODEL.lastResult === "lose") {
      repeatW *= RVAR.repeatBoost;
    }

    const acc = zeroDist();
    const parts = [];

    const freq = predFreq(); if (freq) parts.push(["freq", freq, baseW.freq]);
    const t1 = predTrans1(); if (t1) parts.push(["trans1", t1, baseW.trans1]);
    const t2 = predTrans2(); if (t2) parts.push(["trans2", t2, baseW.trans2]);
    const post = predPostRes(); if (post) parts.push(["post", post, baseW.post]);
    const rep = predRepeat(); if (rep) parts.push(["repeat", rep, repeatW]);
    const ngram = predNgram(history); if (ngram) parts.push(["ngram", ngram, baseW.ngram]);

    // Hover-intent ou Pivot (hesitação)
    const hover = predHoverIntent(snap);
    const pivot = predPivotFromHesitation(snap, hesitant);
    if (pivot) parts.push(["pivot", pivot, baseW.pivot * RVAR.pivotBoost]);
    else if (hover) parts.push(["hover", hover, baseW.hover]);

    // Aplica escalas por desempenho dos preditores
    for (const [name, dist, w] of parts) {
      const scaledW = w * predictorPerfScale(name);
      addWeighted(acc, dist, scaledW);
    }

    return normDist(acc);
  }

  // ---------- Política da IA ----------
  function pickAiMove(predPlayerDist, baseEps) {
    // Score de cada resposta = prob do lance derrotável
    const aiScore = {
      pedra:   predPlayerDist.tesoura, // pedra vence tesoura
      papel:   predPlayerDist.pedra,   // papel vence pedra
      tesoura: predPlayerDist.papel,   // tesoura vence papel
    };

    const eps = RVAR.epsilonEffective(baseEps);
    if (Math.random() < eps) {
      // exploração (aleatória real do navegador)
      return ORDER[Math.floor(Math.random() * ORDER.length)];
    }
    // exploração “suave”: se scores muito próximos, amostra proporcional
    const max = Math.max(aiScore.pedra, aiScore.papel, aiScore.tesoura);
    const close = Object.values(aiScore).every(v => Math.abs(v - max) < RVAR.tieClose);
    if (close) {
      const s = aiScore.pedra + aiScore.papel + aiScore.tesoura || 1;
      const r = Math.random() * s;
      if (r < aiScore.pedra) return "pedra";
      if (r < aiScore.pedra + aiScore.papel) return "papel";
      return "tesoura";
    }
    // determinístico no melhor
    return Object.entries(aiScore).sort((a,b)=>b[1]-a[1])[0][0];
  }

  // ---------- Progressão ----------
  function updateProgression() {
    // Atualiza nível/epsilon conforme dados acumulados
    const r = MODEL.roundsSeen;
    let level = 0;
    if (r >= 5)  level = 1;
    if (r >= 15) level = 2;

    const totalPlays = (TOTALS.wins + TOTALS.losses + TOTALS.draws) || 1;
    const wr = TOTALS.wins / totalPlays;
    if (r >= 40 || wr > 0.60) level = 3;

    MODEL.level = level;
    MODEL.epsilon = RVAR.epsLevels[level]; // ε do nível (já aleatorizado p/ o dia+nome)
  }

  // ---------- Atualização do modelo após cada jogada ----------
  function decayCounts(obj, decay) {
    for (const k in obj) obj[k] *= decay;
  }
  function decayNested(obj, decay) {
    for (const k in obj) {
      const v = obj[k];
      if (typeof v === "object" && v) decayCounts(v, decay);
    }
  }

  function updateModelAfterRound(player, ai, res, snap, decisionMs, usedDists) {
    const d = MODEL.decay;

    // Frequências globais
    decayCounts(MODEL.counts, d);
    MODEL.counts[player] = (MODEL.counts[player] || 0) + 1;

    // Transições 1ª e 2ª ordem
    decayNested(MODEL.trans1, d);
    if (!MODEL.trans1[MODEL.lastMove || ""]) MODEL.trans1[MODEL.lastMove || ""] = {tesoura:1,pedra:1,papel:1};
    if (MODEL.lastMove) MODEL.trans1[MODEL.lastMove][player] = (MODEL.trans1[MODEL.lastMove][player] || 0) + 1;

    if (MODEL.lastTwoKey) {
      if (!MODEL.trans2[MODEL.lastTwoKey]) MODEL.trans2[MODEL.lastTwoKey] = { tesoura:1,pedra:1,papel:1 };
      decayCounts(MODEL.trans2[MODEL.lastTwoKey], d);
      MODEL.trans2[MODEL.lastTwoKey][player] += 1;
    }

    // Pós-resultado
    decayNested(MODEL.postRes, d);
    const bucket = MODEL.postRes[MODEL.lastResult || "draw"];
    if (bucket) bucket[player] = (bucket[player] || 0) + 1;

    // Streak
    if (MODEL.lastMove && MODEL.lastMove === player) MODEL.streak += 1;
    else MODEL.streak = 1;

    // Hesitação: média móvel de tempo (β=0.1)
    const hs = MODEL.hesitation;
    hs.samples += 1;
    hs.avgDecisionMs = Math.round(0.9 * hs.avgDecisionMs + 0.1 * decisionMs);

    // Pivot quando hesitante
    const hesitant = isHesitant(snap, decisionMs);
    if (hesitant) {
      const most = ["tesoura","pedra","papel"].reduce((best, k) =>
        snap.hoverMs[k] > (snap.hoverMs[best] || 0) ? k : best, "tesoura");
      const pv = hs.pivot[most] || (hs.pivot[most] = { tesoura:1, pedra:1, papel:1 });
      decayCounts(pv, d);
      pv[player] = (pv[player] || 0) + 1;
    }

    // Atualiza janela de últimas duas
    MODEL.prevMove = MODEL.lastMove;
    MODEL.lastMove = player;
    MODEL.lastTwoKey = MODEL.prevMove ? `${MODEL.prevMove}|${MODEL.lastMove}` : null;
    MODEL.lastResult = res;

    MODEL.roundsSeen += 1;
    updateProgression();

    // Ajusta pesos dos preditores conforme o quanto apostaram no lance real
    const eta = 0.15; // taxa de aprendizagem
    for (const [name, dist] of Object.entries(usedDists || {})) {
      const reward = dist ? (dist[player] || 0) : 0;
      MODEL.perf[name] = (1 - eta) * (MODEL.perf[name] ?? 0.5) + eta * reward;
    }

    saveLS(LS_KEYS.MODEL, MODEL);
  }

  // ---------- Histórico / Totais ----------
  function pushHistory(entry) {
    const history = loadLS(LS_KEYS.HISTORY, []);
    history.push(entry);
    if (history.length > 300) history.splice(0, history.length - 300);
    saveLS(LS_KEYS.HISTORY, history);
  }
  function updateTotals(res) {
    if (res === "win") TOTALS.wins += 1;
    else if (res === "lose") TOTALS.losses += 1;
    else TOTALS.draws += 1;
    saveLS(LS_KEYS.TOTALS, TOTALS);
  }

  // ---------- Fim da sessão ----------
  function showFinalWinOverlay() {
    finalEmoji.textContent = "🎉";
    finalTitle.textContent = "Você venceu!";
    finalDesc.textContent = "Mande o print para receber o prêmio.";
    centerFinalActionButtons();
    finalOverlay.classList.remove("hidden");
    goHomeBtn.focus();
  }
  function showFinalLoseOverlay() {
    finalEmoji.textContent = "😞";
    finalTitle.textContent = "Você foi derrotado.";
    finalDesc.textContent = `Placar final: ${wins}–${losses}${draws ? ` (Empates: ${draws})` : ""}. Volte ao início e tente novamente.`;
    centerFinalActionButtons();
    finalOverlay.classList.remove("hidden");
    goHomeBtn.focus();
  }
  function hideFinalOverlay() {
    finalOverlay.classList.add("hidden");
    closeGoHomeConfirm();
  }

  // Centraliza botões do overlay final e garante espaçamento
  function centerFinalActionButtons() {
    const row = finalOverlay.querySelector('#closeFinalBtn')?.parentElement;
    if (!row || !row.classList.contains('flex')) return;
    row.classList.remove('justify-end', 'justify-between', 'justify-start');
    row.classList.add('justify-center');
    if (!row.classList.contains('gap-2')) row.classList.add('gap-2');
  }

  function endIfCompleted() {
    if (roundsPlayed < TOTAL_ROUNDS) return;
    moveButtons().forEach(b => b.disabled = true);
    if (wins > losses) showFinalWinOverlay();
    else showFinalLoseOverlay();
  }

  // ---------- Dupla confirmação (Reiniciar / Voltar ao início) ----------
  let resetConfirmStep = 0;
  function openResetConfirm(step = 1) {
    resetConfirmStep = step;
    confirmText.textContent = step === 1
      ? "Tem certeza que deseja reiniciar?"
      : "Última confirmação: isso vai zerar o progresso (50 partidas).";
    confirmBtn.textContent = step === 1 ? "Confirmar (1/2)" : "Confirmar (2/2)";
    confirmBox.classList.remove("hidden");
    confirmBtn.focus();
  }
  function closeResetConfirm() { resetConfirmStep = 0; confirmBox.classList.add("hidden"); }
  function doResetSession() {
    roundsPlayed = 0; wins = 0; losses = 0; draws = 0;
    updateScoreUI(); updateProgressUI();
    moveButtons().forEach(b => b.disabled = false);
    resultEl.classList.add("hidden");
    choicesEl.textContent = "";
    hideFinalOverlay();
    setGreeting();
    newSensorRound();
  }

  let goHomeStep = 0;
  function openGoHomeConfirm(step = 1) {
    goHomeStep = step;
    goHomeConfirmText.textContent = step === 1
      ? "Tem certeza que deseja voltar ao início?"
      : "Última confirmação: você será redirecionado para a página inicial.";
    goHomeConfirm.textContent = step === 1 ? "Confirmar (1/2)" : "Confirmar (2/2)";
    goHomeConfirmBox.classList.remove("hidden");
    goHomeConfirm.focus();
  }
  function closeGoHomeConfirm() { goHomeStep = 0; goHomeConfirmBox.classList.add("hidden"); }
  function goHomeNow() { window.location.href = "index.html"; }

  // ---------- Jogo ----------
  function outcome(player, ai) {
    if (player === ai) return "draw";
    if (
      (player === "pedra" && ai === "tesoura") ||
      (player === "tesoura" && ai === "papel") ||
      (player === "papel" && ai === "pedra")
    ) return "win";
    return "lose";
  }

  function init() {
    // “Voltar ao início se recarregar”: zera só a sessão
    doResetSession();

    setGreeting();
    ensureScoreboardUI();
    updateScoreUI();
    updateProgressUI();
    attachHoverListeners();

    // Reiniciar (dupla confirmação)
    resetBtn.addEventListener("click", () => openResetConfirm(1));
    cancelConfirmBtn.addEventListener("click", closeResetConfirm);
    confirmBtn.addEventListener("click", () => {
      if (resetConfirmStep === 1) openResetConfirm(2);
      else if (resetConfirmStep === 2) { closeResetConfirm(); doResetSession(); }
    });

    // Overlay final
    closeFinalBtn.addEventListener("click", hideFinalOverlay);

    // Voltar ao início (dupla confirmação)
    goHomeBtn.addEventListener("click", () => openGoHomeConfirm(1));
    goHomeCancel.addEventListener("click", closeGoHomeConfirm);
    goHomeConfirm.addEventListener("click", () => {
      if (goHomeStep === 1) openGoHomeConfirm(2);
      else if (goHomeStep === 2) { closeGoHomeConfirm(); goHomeNow(); }
    });

    // Esc/fora fecha popovers
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeResetConfirm(); closeGoHomeConfirm(); }
    });
    document.addEventListener("click", (e) => {
      if (!confirmBox.classList.contains("hidden")) {
        const within = confirmBox.contains(e.target) || e.target === resetBtn;
        if (!within) closeResetConfirm();
      }
      if (!goHomeConfirmBox.classList.contains("hidden")) {
        const within2 = goHomeConfirmBox.contains(e.target) || e.target === goHomeBtn;
        if (!within2) closeGoHomeConfirm();
      }
    });

    // Clique de jogada
    moveButtons().forEach(btn => {
      btn.addEventListener("click", () => {
        if (roundsPlayed >= TOTAL_ROUNDS) return;

        // Snapshot dos sinais antes de ler a escolha do jogador
        const now = performance.now();
        if (sensor && sensor.current) sensor.hoverMs[sensor.current] += (now - sensor.lastAt);
        const decisionMs = sensor ? (now - sensor.startAt) : 0;
        const snap = sensor ? {
          hoverMs: { ...sensor.hoverMs },
          switches: sensor.switches,
          moves: sensor.moves,
          path: sensor.path
        } : { hoverMs:{tesoura:0,pedra:0,papel:0}, switches:0, moves:0, path:0 };

        // Histórico recente p/ n-gram
        const history = loadLS(LS_KEYS.HISTORY, []).slice(-8);

        // Predição do próximo lance do jogador
        const usedDists = {};
        const predDist = (() => {
          // coletamos os individuais p/ atualizar desempenho depois
          const dists = {};
          const L = MODEL.level;
          const baseW = levelWeights(L);
          const freq = predFreq(); if (freq) dists.freq = freq;
          const t1 = predTrans1(); if (t1) dists.trans1 = t1;
          const t2 = predTrans2(); if (t2) dists.trans2 = t2;
          const post = predPostRes(); if (post) dists.post = post;
          const rep = predRepeat(); if (rep) dists.repeat = rep;
          const ngram = predNgram(history); if (ngram) dists.ngram = ngram;

          const hover = predHoverIntent(snap);
          const pivot = predPivotFromHesitation(snap, isHesitant(snap, decisionMs));
          if (pivot) dists.pivot = pivot; else if (hover) dists.hover = hover;

          // Combina com os mesmos pesos da função principal
          const main = predictNextPlayerDist(snap, decisionMs, history);
          // Guardamos as dists usadas p/ scoring
          Object.assign(usedDists, dists);
          return main;
        })();

        // Escolha da IA (ε-greedy com ε efetivo variado por dia+nome)
        const ai = pickAiMove(predDist, MODEL.epsilon);

        const player = btn.getAttribute("data-move");
        const res = outcome(player, ai);

        // UI escolhas + resultado
        choicesEl.innerHTML =
          `Você: <strong>${MOVES[player].emoji} ${MOVES[player].label}</strong> &nbsp;•&nbsp; ` +
          `IA: <strong>${MOVES[ai].emoji} ${MOVES[ai].label}</strong>`;
        setResultUI(resultEl, res);

        // Contadores sessão
        if (res === "win") wins++; else if (res === "lose") losses++; else draws++;
        updateScoreUI();

        // Progresso
        roundsPlayed++;
        updateProgressUI();

        // Persistência (histórico + aprendizado + totais)
        pushHistory({
          t: Date.now(),
          player, ai, res,
          decisionMs,
          hoverMs: snap.hoverMs,
          switches: snap.switches,
          path: Math.round(snap.path),
          variant: RVAR.stamp, // ajuda a auditar o "perfil do dia"
        });
        updateTotals(res);
        updateModelAfterRound(player, ai, res, snap, decisionMs, usedDists);

        endIfCompleted();

        // Prepara sensores para a próxima jogada
        newSensorRound();
      });
    });
  }

  // Espera o DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { newSensorRound(); init(); });
  } else {
    newSensorRound(); init();
  }
})();
