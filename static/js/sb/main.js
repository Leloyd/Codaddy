// SolarBridge command center — orchestration.
import { setNum, tween, fmtHours } from "./motion.js";
import { ApiSource, MockSource } from "./sources.js";
import { createYieldChart } from "./chart.js";
import { createFlow } from "./flow.js";

const $ = (id) => document.getElementById(id);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const TONE = { green: "solar", yellow: "amber", orange: "amber", red: "coral", slate: "ink" };
const HEADLINE = {
  OPTIMAL: "Array at full weather-adjusted capacity",
  SOILING: "Soiling / dust loss",
  SHADING: "Time-of-day shading",
  FAULT: "String fault — open circuit",
  IDLE: "Not enough sun to judge",
};
const ACTION = {
  SOILING: { label: "Log panel cleaning", icon: "spray-can", done: "Cleaning logged — soiling alerts resolved" },
  SHADING: { label: "Mark obstruction cleared", icon: "trees", done: "Obstruction cleared — shading alerts resolved" },
  FAULT: { label: "Mark string repaired", icon: "wrench", done: "Repair logged — fault alerts resolved" },
};
const FEED_ACTION = { SOILING: "Cleaned", SHADING: "Cleared", FAULT: "Repaired", LOW_BATTERY: "Ack", SYSTEM: "Ack" };
const SCENARIO_LABEL = { optimal: "Healthy", soiling: "Dusty Panels", shading: "Shading Drop", fault: "String Fault", brownout: "Night Brownout", recorded: "Recorded Stream" };

const app = { src: null, live: null, impact: null, impactKey: "today", hours: 6, showResolved: false, lastState: null };

// ─────────────────────────────────────────────────────────────── helpers ──
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2400);
}

function icons() { lucide.createIcons({ attrs: { "stroke-width": 1.5 } }); }

function syncSeg(seg, animate = true) {
  const on = seg.querySelector('[aria-checked="true"]');
  const thumb = seg.querySelector(".sb-seg-thumb");
  if (!on || !thumb) return;
  if (!animate) thumb.style.transition = "none";
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  if (!animate) requestAnimationFrame(() => (thumb.style.transition = ""));
}
function check(seg, btn) {
  $$("[role=radio]", seg).forEach((b) => b.setAttribute("aria-checked", String(b === btn)));
  syncSeg(seg);
}

// ──────────────────────────────────────────────────────────── rendering ──
function renderLive(d) {
  app.live = d;
  const cfg = d.config, r = d.reading || {}, dx = d.diagnosis;
  const tone = TONE[dx.color] || "ink";

  // gateway pill + context bar
  const pill = $("gatewayPill");
  pill.dataset.state = d.link.state;
  pill.title = d.poller?.last_error ? `${d.link.detail}\n${d.poller.last_error}` : d.link.detail;
  $("gatewayText").textContent =
    d.link.state === "live" ? `${cfg.gateway_ip} • Connected`
    : d.link.state === "edge_syncing" ? `${cfg.gateway_ip} • Edge Syncing`
    : d.link.state === "mock" ? `Mock stream • ${SCENARIO_LABEL[cfg.sim_scenario]}`
    : `Replay • ${SCENARIO_LABEL[cfg.sim_scenario] || cfg.sim_scenario}`;

  const seg = $("sourceSeg"), modeBtn = seg.querySelector(`[data-mode="${cfg.data_mode}"]`);
  if (modeBtn.getAttribute("aria-checked") !== "true") check(seg, modeBtn);
  const demo = cfg.data_mode === "simulated";
  $("scenarioChips").classList.toggle("hidden", !demo);
  $("liveContext").classList.toggle("hidden", demo);
  $("liveContext").classList.toggle("flex", !demo);
  $("contextLabel").textContent = demo ? "Replay scenario" : "Hardware bridge";
  $$("#scenarioChips .sb-chip").forEach((c) => c.setAttribute("aria-checked", String(c.dataset.scenario === cfg.sim_scenario)));
  $("liveTarget").textContent = `${cfg.gateway_ip}${cfg.gateway_path}`;
  $("liveInterval").textContent = cfg.poll_interval_sec;
  const ts = r.timestamp ? new Date(r.timestamp) : null;
  $("lastUpdate").textContent = ts ? `${d.link.state === "edge_syncing" ? "cached" : "updated"} ${ts.toLocaleTimeString([], { hour12: false })}` : "—";

  // KPI strip
  setNum("pv_watts", r.pv_watts); setNum("pv_watts2", r.pv_watts); setNum("pv_watts3", r.pv_watts);
  setNum("pv_volts", r.pv_volts); setNum("pv_amps", r.pv_amps);
  setNum("bat_soc", r.bat_soc); setNum("bat_soc2", r.bat_soc); setNum("bat_soc3", r.bat_soc);
  setNum("bat_volts", r.bat_volts);
  setNum("load_watts", r.load_watts); setNum("load_watts2", r.load_watts);
  setNum("expected", r.expected_pv_watts); setNum("irradiance", r.irradiance_wm2);
  setNum("efficiency", dx.efficiency);
  $("batWh").textContent = `${Math.round((cfg.battery_capacity_wh * (r.bat_soc || 0)) / 100).toLocaleString()} Wh`;

  const cells = $("cells");
  if (!cells.children.length) cells.innerHTML = "<i></i>".repeat(20);
  const lit = Math.round((r.bat_soc || 0) / 5), low = (r.bat_soc || 0) <= cfg.dod_floor_pct + 10;
  [...cells.children].forEach((c, i) => {
    c.classList.toggle("on", i < lit);
    c.classList.toggle("low", low);
    c.classList.toggle("floor", i < Math.round(cfg.dod_floor_pct / 5));
  });

  const net = d.net || { watts: 0, direction: "balanced" };
  setNum("net_watts", net.watts);
  const nb = $("netBadge");
  nb.dataset.tone = net.direction === "charging" ? "solar" : net.direction === "discharging" ? (low ? "coral" : "cobalt") : "ink";
  $("netLabel").textContent = { charging: "Charging", discharging: "Discharging", balanced: "Balanced" }[net.direction];
  const ni = nb.querySelector("svg");
  if (ni) ni.style.transform = net.direction === "discharging" ? "rotate(180deg)" : "";

  $("effState").textContent = dx.state === "IDLE" ? "Low light" : dx.label;
  $("effState").dataset.tone = tone;
  const eb = $("effBar");
  eb.style.width = `${Math.min(100, dx.efficiency || 0)}%`;
  eb.style.background = `var(--${tone === "ink" ? "faint" : tone})`;

  // flow
  const flowNet = flow.update({ pv: r.pv_watts || 0, load: r.load_watts || 0, soc: r.bat_soc ?? null, floor: cfg.dod_floor_pct });
  setNum("bat_flow", flowNet);
  $("invMode").textContent = Math.abs(flowNet) < 5 ? "Idle · balanced" : flowNet > 0 ? "Charging bank" : "Inverting from bank";

  // diagnostics
  renderDiagnosis(d, tone);
  chart.setGapTone(dx.state === "FAULT" ? "coral" : "amber");

  // runtime
  $("dodFloor").textContent = Math.round(cfg.dod_floor_pct);
  renderRuntime();

  // currency labels
  ["cur1", "cur2", "cur3"].forEach((id) => ($(id).textContent = cfg.currency_symbol));
}

function renderDiagnosis(d, tone) {
  const dx = d.diagnosis;
  const card = $("diag");
  if (app.lastState !== dx.state) {
    card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash");
    app.lastState = dx.state;
  }
  card.dataset.tone = tone;
  $("diagState").dataset.tone = tone;
  $("diagState").textContent = dx.label;
  $("diagHeadline").textContent = HEADLINE[dx.state] || dx.label;
  $("diagReason").textContent = dx.reason;
  $("diagAdvice").textContent = dx.advice;
  $("diagConf").textContent = `confidence ${Math.round((dx.confidence || 0) * 100)}%`;
  setNum("loss_kwh", d.loss ? d.loss.daily_kwh : 0);
  setNum("loss_money", d.loss ? d.loss.daily_money : 0);

  const btn = $("diagAction"), act = ACTION[dx.state];
  const label = act ? act.label : dx.state === "IDLE" ? "Waiting for sunlight" : "No action needed";
  if (btn.dataset.state !== dx.state) {
    btn.dataset.state = dx.state;
    btn.disabled = !act;
    btn.innerHTML = `<i data-lucide="${act ? act.icon : "check"}"></i><span>${label}</span>`;
    icons();
  }
}

// one-click resolution: resolve that category's alerts; in demo mode, also return to a healthy array
async function resolveCategory(cat) {
  const open = (await app.src.alerts(false)).filter((a) => a.category === cat);
  await Promise.all(open.map((a) => app.src.resolve(a.id)));
  toast(ACTION[cat]?.done || "Resolved");
  if (app.live?.config.data_mode === "simulated" && app.live.config.sim_scenario !== "optimal") {
    await setScenario("optimal", false);
  }
  refreshAlerts();
}

// ─────────────────────────────────────────────────────────────── runtime ──
function shedWatts() {
  let w = Number($("other").value);
  $$("#appliances input:checked").forEach((c) => (w += Number(c.dataset.w)));
  return w;
}
const runtime = (cfg, soc, load) => (load <= 1 ? null : (cfg.battery_capacity_wh * Math.max(soc - cfg.dod_floor_pct, 0)) / 100 / load);

function renderRuntime() {
  const range = $("other");
  range.style.setProperty("--pct", `${(range.value / range.max) * 100}%`);
  $("otherVal").textContent = range.value;
  const shed = shedWatts();
  $("shedTotal").textContent = shed ? `−${shed.toLocaleString()}` : "0";
  const d = app.live;
  if (!d?.reading) return;
  const cfg = d.config, r = d.reading;
  const load = r.load_watts || 0;
  const effLoad = Math.max(load - shed, 0);
  const base = runtime(cfg, r.bat_soc, load), next = runtime(cfg, r.bat_soc, effLoad);
  $("clampNote").textContent = shed > load ? `Selected loads exceed the measured ${Math.round(load)} W draw — capped at 0 W.` : "";
  setNum("eff_load", effLoad);

  tween("runtime", next, (v) => ($("runtime").innerHTML = v === null ? "∞<small>unlimited</small>" : fmtHours(v, true)));
  const gain = next === null ? null : next - (base || 0);
  tween("gain", gain, (v) => ($("gain").textContent = next === null ? "+∞" : `+${fmtHours(Math.max(0, v))}`));

  const scale = Math.max(4, ((next ?? base ?? 0) || 0) * 1.12, (base || 0) * 1.12);
  $("rtBase").style.width = base === null ? "100%" : `${Math.min(100, (base / scale) * 100)}%`;
  $("rtNew").style.width = next === null ? "100%" : `${Math.min(100, (next / scale) * 100)}%`;
  $("rtBaseTxt").textContent = fmtHours(base);
  $("rtNewTxt").textContent = fmtHours(next);
}

// ───────────────────────────────────────────────────────────────── impact ──
const MILESTONES = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];
function renderImpact() {
  const i = app.impact?.[app.impactKey];
  const cfg = app.live?.config;
  if (!i || !cfg) return;
  const potential = i.kwh + i.lost_kwh;
  const capture = potential > 0 ? (i.kwh / potential) * 100 : 0;
  setNum("kwh", i.kwh); setNum("co2", i.co2_kg); setNum("savings", i.savings); setNum("capture", capture);
  const left = i.lost_kwh * cfg.electricity_rate_kwh;
  setNum("left_money", left);
  const next = MILESTONES.find((m) => m > i.co2_kg) || MILESTONES[MILESTONES.length - 1];
  const prev = [...MILESTONES].reverse().find((m) => m <= i.co2_kg) || 0;
  $("co2Next").textContent = next.toLocaleString();
  $("pKwh").style.width = `${capture}%`;
  $("pCo2").style.width = `${Math.min(100, ((i.co2_kg - prev) / (next - prev)) * 100)}%`;
  $("pSave").style.width = `${i.savings + left > 0 ? (i.savings / (i.savings + left)) * 100 : 0}%`;
  $("impactNote").textContent = `${cfg.currency_symbol}${cfg.electricity_rate_kwh.toFixed(2)}/kWh tariff · ${cfg.grid_emission_kg_kwh} kg CO₂/kWh grid emission factor · progress bars show harvested vs. weather-expected potential.`;
}

// ───────────────────────────────────────────────────────────────── alerts ──
async function refreshAlerts() {
  const list = await app.src.alerts(app.showResolved);
  const open = list.filter((a) => !a.is_resolved);
  $("alertCount").textContent = open.length;
  const feed = $("feed");
  const sig = list.map((a) => `${a.id}:${a.is_resolved}`).join(",");
  if (feed.dataset.sig === sig) return;          // no re-render → no re-animation
  feed.dataset.sig = sig;
  feed.replaceChildren();
  if (!list.length) {
    feed.innerHTML = '<li class="empty">No open alerts — system healthy.</li>';
    return;
  }
  for (const a of list) {
    const li = document.createElement("li");
    li.dataset.sev = a.severity;
    li.className = a.is_resolved ? "done" : "";
    const dot = document.createElement("i");
    const body = document.createElement("div");
    const m = document.createElement("div");
    m.className = "m";
    m.textContent = a.message;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${a.category.replace("_", " ")} · ${new Date(a.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    body.append(m, meta);
    li.append(dot, body);
    if (!a.is_resolved) {
      const b = document.createElement("button");
      b.className = "sb-btn sb-btn-ghost";
      b.textContent = FEED_ACTION[a.category] || "Resolve";
      b.onclick = async () => { await app.src.resolve(a.id); toast(`${a.category.replace("_", " ").toLowerCase()} alert resolved`); refreshAlerts(); };
      li.append(b);
    } else li.append(document.createElement("span"));
    feed.append(li);
  }
}

// ──────────────────────────────────────────────────────────────── loading ──
async function tick() {
  try { renderLive(await app.src.snapshot()); }
  catch (e) {
    console.warn(e);
    $("gatewayPill").dataset.state = "edge_syncing";
    $("gatewayText").textContent = "Backend offline";
  }
}
async function refreshHistory() {
  try {
    const [rows, spark] = await Promise.all([app.src.history(app.hours), app.src.history(0.5)]);
    chart.setData(rows);
    drawSpark(spark.map((r) => r.pv_watts));
  } catch (e) { console.warn(e); }
}
async function refreshImpact() {
  try { app.impact = await app.src.impact(); renderImpact(); } catch (e) { console.warn(e); }
}

function drawSpark(values) {
  const svg = $("spark");
  const v = values.filter((x) => x !== null && x !== undefined).slice(-60);
  if (v.length < 2) return;
  const max = Math.max(...v, 1) * 1.1, W = 120, H = 40;
  const pts = v.map((y, i) => [(i / (v.length - 1)) * W, H - (y / max) * H]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  svg.querySelector(".sb-spark-line").setAttribute("d", line);
  svg.querySelector(".sb-spark-area").setAttribute("d", `${line}L${W},${H}L0,${H}Z`);
}

async function setScenario(key, announce = true) {
  await app.src.setConfig({ data_mode: "simulated", sim_scenario: key });
  if (announce) toast(`Fault Replay · ${SCENARIO_LABEL[key]}`);
  await tick();                                  // instant response
  refreshHistory(); refreshAlerts();
}

// ─────────────────────────────────────────────────────────────── controls ──
function wireControls() {
  $$("#sourceSeg [data-mode]").forEach((b) => b.addEventListener("click", async () => {
    check($("sourceSeg"), b);
    await app.src.setConfig({ data_mode: b.dataset.mode });
    toast(b.dataset.mode === "live" ? "Live Hardware · polling local gateway" : "Fault Replay Demo");
    await tick(); refreshHistory();
  }));
  $$("#scenarioChips .sb-chip").forEach((c) => c.addEventListener("click", () => {
    $$("#scenarioChips .sb-chip").forEach((x) => x.setAttribute("aria-checked", String(x === c)));
    setScenario(c.dataset.scenario);
  }));
  $$("#rangeSeg [data-h]").forEach((b) => b.addEventListener("click", () => {
    check($("rangeSeg"), b); app.hours = Number(b.dataset.h); chart.setRange(app.hours); refreshHistory();
  }));
  $$("#impactSeg [data-k]").forEach((b) => b.addEventListener("click", () => {
    check($("impactSeg"), b); app.impactKey = b.dataset.k; renderImpact();
  }));
  $("appliances").addEventListener("change", renderRuntime);
  $("other").addEventListener("input", renderRuntime);
  $("diagAction").addEventListener("click", () => {
    const s = $("diagAction").dataset.state;
    if (ACTION[s]) resolveCategory(s);
  });
  $("toggleResolved").addEventListener("click", () => {
    app.showResolved = !app.showResolved;
    $("toggleResolved").textContent = app.showResolved ? "Hide resolved" : "Show resolved";
    refreshAlerts();
  });

  // theme
  $("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.classList.toggle("dark", next === "dark");
    try { localStorage.setItem("sb-theme", next); } catch (e) { /* storage blocked */ }
    chart.theme();
  });

  // drawer
  const drawer = $("drawer"), scrim = $("scrim"), form = $("configForm");
  const open = async () => {
    const cfg = await app.src.getConfig();
    for (const el of form.elements) if (el.name && cfg[el.name] !== undefined) el.value = cfg[el.name];
    scrim.hidden = false;
    drawer.inert = false;
    drawer.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => { scrim.classList.add("open"); drawer.classList.add("open"); });
    setTimeout(() => form.elements.site_name.focus(), 220);
  };
  const close = () => {
    scrim.classList.remove("open"); drawer.classList.remove("open");
    drawer.inert = true;
    drawer.setAttribute("aria-hidden", "true");
    setTimeout(() => (scrim.hidden = true), 220);
    $("openConfig").focus();
  };
  $("openConfig").addEventListener("click", open);
  scrim.addEventListener("click", close);
  $$("[data-close]", drawer).forEach((b) => b.addEventListener("click", close));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer.classList.contains("open")) close(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await app.src.setConfig(Object.fromEntries(new FormData(form).entries()));
      close(); toast("Gateway configuration saved");
      tick(); refreshImpact();
    } catch (err) { toast(`Save failed: ${err.message}`); }
  });

  addEventListener("resize", () => ["sourceSeg", "rangeSeg", "impactSeg"].forEach((id) => syncSeg($(id), false)));
}

// ──────────────────────────────────────────────────────────────── startup ──
icons();
const chart = createYieldChart($("yieldChart"), $("tip"));
const flow = createFlow($("flow"));

(async function start() {
  const forceMock = new URLSearchParams(location.search).has("mock");
  app.src = new ApiSource();
  if (forceMock) app.src = new MockSource();
  else {
    try { await app.src.snapshot(); }
    catch { app.src = new MockSource(); toast("Backend unreachable — running built-in mock stream"); }
  }
  wireControls();
  await tick();
  ["sourceSeg", "rangeSeg", "impactSeg"].forEach((id) => syncSeg($(id), false));
  document.fonts?.ready.then(() => ["sourceSeg", "rangeSeg", "impactSeg"].forEach((id) => syncSeg($(id), false)));
  refreshHistory(); refreshImpact(); refreshAlerts();
  setInterval(tick, 3000);
  setInterval(() => { refreshHistory(); refreshAlerts(); }, app.src.kind === "mock" ? 3000 : 6000);
  setInterval(refreshImpact, 30000);
})();
