const WEIGHT_LABELS = {
  elo: "Elo",
  fifa: "FIFA",
  form: "状态",
  player: "球员",
  style: "战术",
  matchup: "对位",
  venue: "主场/旅行",
  context: "世界杯语境",
};

let payload = null;
let activeTeams = [];
let allTeams = [];

const percent = (value) => `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;

function aliasEntry(teamName) {
  return payload?.team_aliases?.[teamName] || null;
}

function displayTeamName(teamName) {
  return aliasEntry(teamName)?.display_name || teamName;
}

function teamSearchText(team) {
  const entry = aliasEntry(team.team);
  return [team.team, entry?.display_name, ...(entry?.aliases || [])].filter(Boolean).join(" ").toLowerCase();
}

function displayMatchLabel(match) {
  return `${displayTeamName(match.home)} vs ${displayTeamName(match.away)}`;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda, random) {
  const limit = Math.exp(-lambda);
  let product = 1;
  let k = 0;
  do {
    k += 1;
    product *= random();
  } while (product > limit);
  return k - 1;
}

function normalizedWeights() {
  const rows = [...document.querySelectorAll("[data-weight]")];
  const raw = Object.fromEntries(rows.map((row) => [row.dataset.weight, Number(row.value)]));
  const total = Object.values(raw).reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Math.max(0, value) / total]));
}

function recalcStrengths(teams, weights) {
  return teams.map((team) => {
    const baseContributions = team.contributions;
    const originalWeights = payload.metadata.weights;
    const components = Object.fromEntries(
      Object.keys(weights).map((key) => {
        const component = originalWeights[key] > 0 ? baseContributions[key] / originalWeights[key] : 0;
        return [key, component];
      }),
    );
    const contributions = Object.fromEntries(Object.keys(weights).map((key) => [key, weights[key] * components[key]]));
    return {...team, strength: Object.values(contributions).reduce((sum, value) => sum + value, 0), contributions};
  });
}

function lambdas(a, b) {
  const strengthDelta = a.strength - b.strength;
  const attackDelta = (a.attack - b.defense) - (b.attack - a.defense);
  const aLambda = 1.35 * Math.exp(0.58 * strengthDelta + 0.18 * attackDelta);
  const bLambda = 1.35 * Math.exp(-0.58 * strengthDelta - 0.18 * attackDelta);
  return [Math.min(4.8, Math.max(0.25, aLambda)), Math.min(4.8, Math.max(0.25, bLambda))];
}

function playMatch(a, b, random) {
  const [la, lb] = lambdas(a, b);
  return [poisson(la, random), poisson(lb, random)];
}

function matchProbabilities(a, b) {
  const [la, lb] = lambdas(a, b);
  const maxGoals = 9;
  const home = [];
  const away = [];
  let homeSum = 0;
  let awaySum = 0;
  for (let goals = 0; goals <= maxGoals; goals += 1) {
    const homeP = Math.exp(-la) * (la ** goals) / factorial(goals);
    const awayP = Math.exp(-lb) * (lb ** goals) / factorial(goals);
    home.push(homeP);
    away.push(awayP);
    homeSum += homeP;
    awaySum += awayP;
  }
  home[maxGoals] += Math.max(0, 1 - homeSum);
  away[maxGoals] += Math.max(0, 1 - awaySum);
  let win = 0;
  let draw = 0;
  let loss = 0;
  for (let hg = 0; hg <= maxGoals; hg += 1) {
    for (let ag = 0; ag <= maxGoals; ag += 1) {
      const p = home[hg] * away[ag];
      if (hg > ag) win += p;
      else if (hg === ag) draw += p;
      else loss += p;
    }
  }
  const total = win + draw + loss;
  return {win: win / total, draw: draw / total, loss: loss / total, expectedGoals: {home: la, away: lb}};
}

function marketForMatch(homeName, awayName) {
  return (payload.featured_matches || []).find((match) => match.home === homeName && match.away === awayName)?.market || null;
}

function featuredMatchFor(homeName, awayName) {
  return (payload.featured_matches || []).find((match) => match.home === homeName && match.away === awayName) || null;
}

function blendedProbabilities(model, market, weight) {
  if (!market) return null;
  const benchmark = market.benchmark_probabilities || market.moneyline?.probabilities;
  if (!benchmark) return null;
  const blended = {
    win: (1 - weight) * model.win + weight * benchmark.win,
    draw: (1 - weight) * model.draw + weight * benchmark.draw,
    loss: (1 - weight) * model.loss + weight * benchmark.loss,
  };
  const total = blended.win + blended.draw + blended.loss;
  return {win: blended.win / total, draw: blended.draw / total, loss: blended.loss / total};
}

function calibratedExpectedGoals(modelGoals, market, weight) {
  if (!market || !market.total_goals) return null;
  const modelTotal = modelGoals.home + modelGoals.away;
  const marketTotal = market.total_goals.expected_total_goals;
  const calibratedTotal = (1 - weight) * modelTotal + weight * marketTotal;
  const scale = modelTotal > 0 ? calibratedTotal / modelTotal : 1;
  return {home: modelGoals.home * scale, away: modelGoals.away * scale};
}

function factorial(value) {
  let result = 1;
  for (let i = 2; i <= value; i += 1) result *= i;
  return result;
}

function knockoutWinner(a, b, random) {
  const [ga, gb] = playMatch(a, b, random);
  if (ga > gb) return a;
  if (gb > ga) return b;
  const pA = 1 / (1 + Math.exp(-2.4 * (a.strength - b.strength)));
  return random() < pA ? a : b;
}

function sortTable(rows) {
  return rows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || b.strength - a.strength);
}

function simulateBrowser() {
  const simulations = Math.max(500, Math.min(50000, Number(document.querySelector("#simulations").value) || 10000));
  const seed = Number(document.querySelector("#seed").value) || 1;
  const random = mulberry32(seed);
  const weights = normalizedWeights();
  const teams = recalcStrengths(payload.teams, weights);
  allTeams = recalcStrengths(payload.all_teams, weights);
  const byName = Object.fromEntries(teams.map((team) => [team.team, team]));
  const counts = Object.fromEntries(teams.map((team) => [team.team, {round32: 0, round16: 0, quarterfinal: 0, semifinal: 0, final: 0, champion: 0}]));

  for (let sim = 0; sim < simulations; sim += 1) {
    const round32 = [];
    const thirds = [];
    Object.entries(payload.tournament.groups).forEach(([group, names]) => {
      const table = Object.fromEntries(
        names.map((name) => [name, {team: name, group, points: 0, gf: 0, ga: 0, gd: 0, strength: byName[name].strength}]),
      );
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          const a = byName[names[i]];
          const b = byName[names[j]];
          const [ga, gb] = playMatch(a, b, random);
          table[a.team].gf += ga;
          table[a.team].ga += gb;
          table[b.team].gf += gb;
          table[b.team].ga += ga;
          if (ga > gb) table[a.team].points += 3;
          else if (gb > ga) table[b.team].points += 3;
          else {
            table[a.team].points += 1;
            table[b.team].points += 1;
          }
        }
      }
      Object.values(table).forEach((row) => {
        row.gd = row.gf - row.ga;
      });
      const ranked = sortTable(Object.values(table));
      round32.push(ranked[0].team, ranked[1].team);
      thirds.push(ranked[2]);
    });

    sortTable(thirds).slice(0, 8).forEach((row) => round32.push(row.team));
    round32.forEach((team) => counts[team].round32 += 1);
    let current = round32.sort((a, b) => byName[b].strength - byName[a].strength);
    [["round16", 16], ["quarterfinal", 8], ["semifinal", 4], ["final", 2], ["champion", 1]].forEach(([stage]) => {
      const winners = [];
      for (let i = 0; i < current.length / 2; i += 1) {
        winners.push(knockoutWinner(byName[current[i]], byName[current[current.length - 1 - i]], random).team);
      }
      if (stage === "champion") counts[winners[0]].champion += 1;
      else winners.forEach((team) => counts[team][stage] += 1);
      current = winners;
    });
  }

  activeTeams = teams.map((team) => ({
    ...team,
    probabilities: {
      group: 1,
      round32: counts[team.team].round32 / simulations,
      round16: counts[team.team].round16 / simulations,
      quarterfinal: counts[team.team].quarterfinal / simulations,
      semifinal: counts[team.team].semifinal / simulations,
      final: counts[team.team].final / simulations,
      champion: counts[team.team].champion / simulations,
    },
  })).sort((a, b) => b.probabilities.champion - a.probabilities.champion);

  document.querySelector("#simCount").textContent = simulations.toLocaleString("zh-CN");
  renderTeams();
  renderTeamSelect();
  renderSingleMatch();
}

function renderWeights() {
  const host = document.querySelector("#weights");
  host.innerHTML = "";
  Object.entries(payload.metadata.weights).forEach(([key, value]) => {
    const row = document.createElement("div");
    row.className = "weight-row";
    row.innerHTML = `
      <span>${WEIGHT_LABELS[key]}</span>
      <input data-weight="${key}" type="range" min="0" max="100" value="${Math.round(value * 100)}">
      <span>${Math.round(value * 100)}</span>
    `;
    const input = row.querySelector("input");
    const valueText = row.querySelector("span:last-child");
    input.addEventListener("input", () => {
      valueText.textContent = input.value;
    });
    host.appendChild(row);
  });
}

function renderTeams() {
  const query = document.querySelector("#search").value.trim().toLowerCase();
  const rows = document.querySelector("#teamRows");
  rows.innerHTML = "";
  activeTeams
    .filter((team) => teamSearchText(team).includes(query))
    .forEach((team) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td><span class="team-cell">${displayTeamName(team.team)}<span class="confed">${team.confederation}</span></span></td>
        <td>${Math.round(team.elo)}</td>
        <td>${percent(team.probabilities.round32)}</td>
        <td>${percent(team.probabilities.round16)}</td>
        <td>${percent(team.probabilities.quarterfinal)}</td>
        <td>${percent(team.probabilities.semifinal)}</td>
        <td>${percent(team.probabilities.final)}</td>
        <td class="champion">${percent(team.probabilities.champion)}</td>
      `;
      rows.appendChild(row);
    });
  const top = activeTeams[0];
  document.querySelector("#topChampion").textContent = top ? `${top.team} ${percent(top.probabilities.champion)}` : "-";
}

function renderMatchSelectors() {
  const home = document.querySelector("#homeTeamSelect");
  const away = document.querySelector("#awayTeamSelect");
  const options = allTeams.map((team) => `<option value="${team.team}">${displayTeamName(team.team)}</option>`).join("");
  home.innerHTML = options;
  away.innerHTML = options;
  home.value = "Canada";
  away.value = "Bosnia and Herzegovina";
}

function renderMatchPresets() {
  const host = document.querySelector("#matchPresets");
  host.innerHTML = payload.featured_matches
    .map((match) => `<button class="preset-button" type="button" data-home="${match.home}" data-away="${match.away}">${displayMatchLabel(match)}</button>`)
    .join("");
  host.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector("#homeTeamSelect").value = button.dataset.home;
      document.querySelector("#awayTeamSelect").value = button.dataset.away;
      renderSingleMatch();
    });
  });
}

function renderSingleMatch() {
  const homeName = document.querySelector("#homeTeamSelect").value;
  const awayName = document.querySelector("#awayTeamSelect").value;
  const home = allTeams.find((team) => team.team === homeName);
  const away = allTeams.find((team) => team.team === awayName);
  if (!home || !away) return;
  if (home.team === away.team) {
    document.querySelector("#matchNote").textContent = "请选择两支不同球队。";
    return;
  }
  const probs = matchProbabilities(home, away);
  const featuredMatch = featuredMatchFor(home.team, away.team);
  const market = featuredMatch?.market || null;
  const prematch = featuredMatch?.prematch || null;
  const prematchProbs = prematch?.probabilities || probs;
  const prematchGoals = prematch?.expected_goals || probs.expectedGoals;
  const marketWeight = payload.metadata.single_match_market_weight ?? 0.35;
  const calibrated = blendedProbabilities(prematchProbs, market, marketWeight);
  const calibratedGoals = calibratedExpectedGoals(prematchGoals, market, marketWeight);
  const displayProbs = calibrated || prematchProbs;
  const displayGoals = calibratedGoals || prematchGoals;
  document.querySelector("#homeWinLabel").textContent = `${displayTeamName(home.team)} 胜`;
  document.querySelector("#awayWinLabel").textContent = `${displayTeamName(away.team)} 胜`;
  document.querySelector("#homeWinProb").textContent = percent(displayProbs.win);
  document.querySelector("#drawProb").textContent = percent(displayProbs.draw);
  document.querySelector("#awayWinProb").textContent = percent(displayProbs.loss);
  document.querySelector("#expectedScore").textContent = `${displayGoals.home.toFixed(2)} : ${displayGoals.away.toFixed(2)}`;
  const benchmark = market?.benchmark_probabilities || market?.moneyline?.probabilities;
  document.querySelector("#homeWinCompare").textContent = benchmark ? `模型 ${percent(probs.win)} / 赛前 ${percent(prematchProbs.win)} / 基准 ${percent(benchmark.win)}` : `模型 ${percent(probs.win)} / 赛前 ${percent(prematchProbs.win)}`;
  document.querySelector("#drawCompare").textContent = benchmark ? `模型 ${percent(probs.draw)} / 赛前 ${percent(prematchProbs.draw)} / 基准 ${percent(benchmark.draw)}` : `模型 ${percent(probs.draw)} / 赛前 ${percent(prematchProbs.draw)}`;
  document.querySelector("#awayWinCompare").textContent = benchmark ? `模型 ${percent(probs.loss)} / 赛前 ${percent(prematchProbs.loss)} / 基准 ${percent(benchmark.loss)}` : `模型 ${percent(probs.loss)} / 赛前 ${percent(prematchProbs.loss)}`;
  document.querySelector("#expectedScoreCompare").textContent = market?.total_goals
    ? `模型总 ${((probs.expectedGoals.home + probs.expectedGoals.away).toFixed(2))} / 市场总 ${market.total_goals.expected_total_goals.toFixed(2)}`
    : `模型总 ${(probs.expectedGoals.home + probs.expectedGoals.away).toFixed(2)}`;
  renderMarketSummary(market, marketWeight);
  renderProbabilityMatrix(probs, prematch, market, calibrated);
  renderDisagreement(market);
  document.querySelector("#matchNote").textContent = `强度差 ${displayTeamName(home.team)} ${home.strength >= away.strength ? "+" : ""}${(home.strength - away.strength).toFixed(3)}。主数字为${market ? "原始模型与市场/外部基准校准后" : "原始模型"} 90 分钟概率，不是投注建议。`;
  renderMatchDelta(home, away);
  renderPrematchIntelligence(prematch, home, away);
  renderGoalRisk(featuredMatch?.goal_risk || null);
  renderPlayerProfile(home, away, featuredMatch);
}

function yesNo(value) {
  return value ? "是" : "否";
}

function riskBadgeClass(value) {
  if (["高", "强", "是", "极端比分"].includes(value)) return "risk-high";
  if (["中", "大比分", "正常比分"].includes(value)) return "risk-medium";
  return "risk-low";
}

function renderGoalRisk(goalRisk) {
  const host = document.querySelector("#goalRiskPanel");
  if (!host) return;
  if (!goalRisk) {
    host.innerHTML = `<p class="muted-note">暂无该对阵的进球上限与崩盘风险评估；当前只显示基础胜平负和均值预期比分。</p>`;
    return;
  }
  const metrics = [
    ["总进球 3+", percent(goalRisk.total_goals_3_plus)],
    ["总进球 4+", percent(goalRisk.total_goals_4_plus)],
    ["总进球 5+", percent(goalRisk.total_goals_5_plus)],
    [`${displayTeamName(goalRisk.favorite)} 进球 3+`, percent(goalRisk.favorite_goals_3_plus)],
    [`${displayTeamName(goalRisk.favorite)} 进球 4+`, percent(goalRisk.favorite_goals_4_plus)],
  ];
  const labels = [
    ["比赛类型", goalRisk.match_type],
    ["大球倾向", goalRisk.over_tendency],
    ["小球倾向", goalRisk.under_tendency],
    ["强队火力上限", goalRisk.favorite_firepower_ceiling],
    ["弱队崩盘风险", goalRisk.underdog_collapse_risk],
    ["比赛加速风险", goalRisk.match_acceleration_risk],
    ["市场大球信号", goalRisk.market_over_signal],
    ["模型标记：不宜简单支持小球", yesNo(goalRisk.ban_under_bet)],
    ["提示模型低估大比分", yesNo(goalRisk.model_underestimates_blowout)],
    ["推荐关注比分区间", goalRisk.score_band_focus],
  ];
  host.innerHTML = `
    <div class="risk-label-grid">
      ${labels.map(([label, value]) => `
        <div>
          <span>${label}</span>
          <strong class="${riskBadgeClass(value)}">${value}</strong>
        </div>
      `).join("")}
    </div>
    <div class="tail-metrics">
      ${metrics.map(([label, value]) => `
        <div>
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `).join("")}
    </div>
    <div class="risk-drivers">
      ${(goalRisk.drivers || []).map((driver) => `<span>${driver}</span>`).join("")}
    </div>
    <p class="muted-note">该模块专门识别大比分尾部和弱队连续失球风险，不替代胜平负模型，也不是投注建议。</p>
  `;
}

function renderPrematchIntelligence(prematch, home, away) {
  const host = document.querySelector("#prematchIntelligence");
  if (!prematch) {
    host.innerHTML = `<p class="muted-note">暂无该对阵的赛前情报。无情报时不修正模型。</p>`;
    return;
  }
  const fields = [
    ["训练", "training_readiness_score"],
    ["核心", "key_player_status_score"],
    ["首发", "lineup_confidence_score"],
    ["战术", "tactical_cohesion_score"],
    ["主帅", "coach_signal_score"],
    ["旅行", "travel_acclimation_score"],
    ["干扰", "disruption_risk_score"],
    ["爆发", "upside_trigger_score"],
  ];
  const renderTeam = (label, data) => `
    <div class="prematch-team">
      <strong>${displayTeamName(label)}</strong>
      <span class="${data.active ? "active-source" : "display-source"}">${data.active ? "进入模型" : "仅提示"}</span>
      ${fields.map(([name, key]) => `
        <div class="mini-row">
          <span>${name}</span>
          <div class="mini-track"><div style="width:${Math.max(2, data.scores[key] * 100)}%"></div></div>
          <small>${data.scores[key].toFixed(2)}</small>
        </div>
      `).join("")}
      <p>置信度 ${percent(data.source_confidence)} · ${data.source_tier || "none"}</p>
    </div>
  `;
  const risk = prematch.risk_metrics;
  host.innerHTML = `
    <div class="prematch-grid">
      ${renderTeam(home.team, prematch.home)}
      ${renderTeam(away.team, prematch.away)}
    </div>
    <div class="prematch-risk">
      <span>主胜 ${formatSignedPercentPoint(prematch.effect.home_win_shift)}</span>
      <span>大胜2+ ${formatSignedPercentPoint(risk.blowout_probability_shift_2_plus)}</span>
      <span>大胜3+ ${formatSignedPercentPoint(risk.blowout_probability_shift_3_plus)}</span>
      <span>爆冷胜 ${formatSignedPercentPoint(risk.upset_probability_shift)}</span>
      <span>弱势方不败 ${formatSignedPercentPoint(risk.underdog_unbeaten_shift)}</span>
    </div>
    <p class="muted-note">低置信来源只展示不计算。模块总封顶 ${formatSignedPercentPoint(prematch.effect.max_module_shift)}，单来源封顶 ${formatSignedPercentPoint(prematch.effect.single_source_cap)}。</p>
    <p class="muted-note">更新时间：${prematch.home.last_updated_at || "-"} / ${prematch.away.last_updated_at || "-"}</p>
  `;
}

function renderPlayerProfile(home, away, featuredMatch) {
  const host = document.querySelector("#playerProfileCompare");
  const rows = [
    ["球员总分", "score"],
    ["核心球员", "star_power"],
    ["阵容深度", "squad_depth"],
    ["可用性", "availability"],
    ["门将", "goalkeeper"],
    ["伤停风险", "injury_risk"],
  ];
  host.innerHTML = `
    <div class="player-grid">
      <strong></strong>
      <strong>${displayTeamName(home.team)}</strong>
      <strong>${displayTeamName(away.team)}</strong>
      ${rows.map(([label, key]) => `
        <span>${label}</span>
        <span>${home.player_profile[key].toFixed(2)}</span>
        <span>${away.player_profile[key].toFixed(2)}</span>
      `).join("")}
    </div>
    <p>${home.player_profile.notes}</p>
    <p>${away.player_profile.notes}</p>
    ${renderGroupStageValue(featuredMatch, home, away)}
  `;
}

function renderMarketSummary(market, weight) {
  const host = document.querySelector("#marketSummary");
  if (!market) {
    host.innerHTML = `<span>暂无该对阵赔率或外部基准，当前显示原始模型概率。</span>`;
    return;
  }
  const handicap = market.handicap
    ? `让球 ${market.handicap.home_line > 0 ? "+" : ""}${market.handicap.home_line}: 主队覆盖 ${percent(market.handicap.home_cover)}`
    : "暂无让球";
  const total = market.total_goals
    ? `大小 ${market.total_goals.line}: 大 ${percent(market.total_goals.over)} / 小 ${percent(market.total_goals.under)}`
    : "暂无大小球";
  const opta = market.external_forecast
    ? `${market.external_forecast.source}: ${percent(market.external_forecast.probabilities.win)} / ${percent(market.external_forecast.probabilities.draw)} / ${percent(market.external_forecast.probabilities.loss)}`
    : "暂无外部预测";
  const moneyline = market.moneyline
    ? `独赢 ${market.moneyline.home_win_odds} / ${market.moneyline.draw_odds} / ${market.moneyline.away_win_odds}`
    : "暂无独赢赔率";
  host.innerHTML = `
    <span>最终校准权重 ${Math.round(weight * 100)}%</span>
    <span>${moneyline}</span>
    <span>${opta}</span>
    <span>${total}</span>
    <span>${handicap}</span>
  `;
}

function renderProbabilityMatrix(model, prematch, market, calibrated) {
  const host = document.querySelector("#probabilityMatrix");
  const rows = [
    ["独立模型", model],
  ];
  if (prematch?.probabilities) rows.push(["赛前修正后", prematch.probabilities]);
  if (market?.moneyline?.probabilities) rows.push(["赔率去水", market.moneyline.probabilities]);
  if (market?.external_forecast?.probabilities) rows.push([market.external_forecast.source, market.external_forecast.probabilities]);
  if (calibrated) rows.push(["最终参考", calibrated]);
  host.innerHTML = `
    <div class="matrix-row matrix-head"><span>来源</span><span>主胜</span><span>平</span><span>客胜</span></div>
    ${rows.map(([label, probs]) => `
      <div class="matrix-row">
        <span>${label}</span>
        <strong>${percent(probs.win)}</strong>
        <strong>${percent(probs.draw)}</strong>
        <strong>${percent(probs.loss)}</strong>
      </div>
    `).join("")}
  `;
}

function renderDisagreement(market) {
  const host = document.querySelector("#disagreementNote");
  if (!market?.disagreement) {
    host.textContent = "暂无赔率或外部预测，当前只显示独立模型。";
    return;
  }
  const gap = market.disagreement.home_gap * 100;
  host.textContent = `${market.disagreement.summary} 主胜差异 ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pct。Opta/赔率是外部基准，不是训练目标。`;
}

function renderMatchDelta(home, away) {
  const host = document.querySelector("#matchDeltaBars");
  const market = marketForMatch(home.team, away.team);
  const rows = Object.keys(home.contributions).map((key) => ({
    key,
    label: WEIGHT_LABELS[key],
    weight: payload.metadata.weights[key] || 0,
    delta: home.contributions[key] - away.contributions[key],
    impact: home.contributions[key] - away.contributions[key],
    kind: "model",
  }));
  if (market?.market_effect) {
    const benchmark = market.benchmark_probabilities || market.moneyline?.probabilities || {win: 0, loss: 0};
    rows.push({
      key: "market_effect",
      label: "市场/外部校准",
      weight: market.market_effect.market_weight,
      delta: benchmark.win - benchmark.loss,
      impact: market.market_effect.home_win_shift,
      kind: "market",
    });
  }
  const maxImpact = Math.max(...rows.map((row) => Math.abs(row.impact)), 0.01);
  host.innerHTML = `
    <div class="impact-header">
      <span>维度</span>
      <span>权重</span>
      <span>差值 / 拉动</span>
    </div>
    ${rows.map((row) => {
      const width = Math.max(2, Math.abs(row.impact) / maxImpact * 100);
      const side = row.impact >= 0 ? "home" : "away";
      const value = row.kind === "market"
        ? `${formatSignedPercentPoint(row.impact)}`
        : `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(3)}`;
      return `
        <div class="impact-row ${row.kind}">
          <span>${row.label}</span>
          <span>${Math.round(row.weight * 100)}%</span>
          <div>
            <div class="delta-track"><div class="delta-fill ${side}" style="width:${width}%"></div></div>
            <small>${value}</small>
          </div>
        </div>
      `;
    }).join("")}
    <p class="impact-note">Elo/FIFA/球员/主场/世界杯语境为原始模型层；市场/外部校准为最终层对主胜概率的百分点拉动。</p>
  `;
}

function formatSignedPercentPoint(value) {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)}pct`;
}

function renderTeamSelect() {
  const select = document.querySelector("#teamSelect");
  const selected = select.value || activeTeams[0]?.team;
  select.innerHTML = activeTeams.map((team) => `<option value="${team.team}">${displayTeamName(team.team)}</option>`).join("");
  select.value = activeTeams.some((team) => team.team === selected) ? selected : activeTeams[0]?.team;
  renderContributions();
}

function renderContributions() {
  const name = document.querySelector("#teamSelect").value;
  const team = activeTeams.find((item) => item.team === name);
  const host = document.querySelector("#contributionBars");
  if (!team) return;
  const maxValue = Math.max(...Object.values(team.contributions), 0.01);
  host.innerHTML = Object.entries(team.contributions)
    .map(([key, value]) => `
      <div class="bar-row">
        <span>${WEIGHT_LABELS[key]}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (value / maxValue) * 100)}%"></div></div>
        <span>${value.toFixed(3)}</span>
      </div>
    `)
    .join("");
}

function renderGroupStageValue(match, home, away) {
  const value = match?.group_stage_value;
  if (!value) return "";
  return `
    <div class="player-grid context-grid">
      <strong>小组赛价值</strong>
      <strong>${displayTeamName(home.team)}</strong>
      <strong>${displayTeamName(away.team)}</strong>
      <span>胜利价值</span>
      <span>${percent(value.home_win_value)}</span>
      <span>-</span>
      <span>平局可接受度</span>
      <span>${percent(value.draw_acceptability)}</span>
      <span>${percent(value.draw_acceptability)}</span>
      <span>主队输球风险</span>
      <span>${percent(value.home_loss_risk)}</span>
      <span>-</span>
    </div>
    <p>${value.format_note}</p>
  `;
}

function renderGroups() {
  const host = document.querySelector("#groups");
  host.innerHTML = Object.entries(payload.tournament.groups)
    .map(([group, teams]) => `
      <div class="group-box">
        <strong>${group} 组</strong>
        ${teams.map((team) => `<span>${team}</span>`).join("")}
      </div>
    `)
    .join("");
}

function renderMatches() {
  const rows = document.querySelector("#matchRows");
  rows.innerHTML = payload.example_match_probabilities
    .slice(0, 12)
    .map((match) => `
      <tr>
        <td>${displayTeamName(match.team_a)} vs ${displayTeamName(match.team_b)}</td>
        <td>${percent(match.win)}</td>
        <td>${percent(match.draw)}</td>
        <td>${percent(match.loss)}</td>
      </tr>
    `)
    .join("");
}

function renderNotes() {
  const notes = document.querySelector("#dataNotes");
  notes.innerHTML = [
    payload.metadata.data_warning,
    "原始模型不再把赔率作为普通特征；赔率和 Opta 等外部预测只进入最终校准层。",
    "球员、主场/旅行、世界杯小组赛语境会影响原始模型概率，缺失时使用中性回退。",
  ].map((item) => `<li>${item}</li>`).join("");
}

async function init() {
  try {
    const response = await fetch("model_output.json", {cache: "no-store"});
    payload = await response.json();
    activeTeams = payload.teams;
    allTeams = payload.all_teams || payload.teams;
    renderWeights();
    renderMatchSelectors();
    renderMatchPresets();
    renderSingleMatch();
    renderTeams();
    renderTeamSelect();
    renderGroups();
    renderMatches();
    renderNotes();
    document.querySelector("#simCount").textContent = payload.metadata.simulations.toLocaleString("zh-CN");
    document.querySelector("#status").textContent = "已加载";
  } catch (error) {
    document.querySelector("#status").textContent = "读取失败";
    document.querySelector(".content").innerHTML = `<section class="table-section"><h2>无法读取 model_output.json</h2><p>请通过本地静态服务打开 public 目录，或先运行 Python 模拟脚本生成结果。</p></section>`;
  }
}

document.querySelector("#runButton").addEventListener("click", simulateBrowser);
document.querySelector("#search").addEventListener("input", renderTeams);
document.querySelector("#teamSelect").addEventListener("change", renderContributions);
document.querySelector("#homeTeamSelect").addEventListener("change", renderSingleMatch);
document.querySelector("#awayTeamSelect").addEventListener("change", renderSingleMatch);

init();
