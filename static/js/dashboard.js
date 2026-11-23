/* SolarBridge AI dashboard: polling, Chart.js graphs, what-if load shedding. */
(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
  const state = { live: null, hours: 6, impact: null, impactKey: "today", showResolved: false };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" }, ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function hrs(h) {
    if (h === null || h === undefined) return "∞";
    const H = Math.floor(h), M = Math.round((h - H) * 60);
    return `${H}h ${String(M).padStart(2, "0")}m`;
  }

  // ------------------------------------------------------------ live view --
  function renderLive(d) {
    state.live = d;
    const cfg = d.config, r = d.reading || {}, dx = d.diagnosis;

    $("siteName").textContent = cfg.site_name;
    const badge = $("linkBadge");
    badge.dataset.state = d.link.state;
    badge.querySelector("b").textContent = d.link.label;
    badge.title = d.poller.last_error ? `${d.link.detail}\n${d.poller.last_error}` : d.link.detail;

    document.querySelectorAll(".seg [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === cfg.data_mode));
    const sel = $("scenario");
    if (document.activeElement !== sel) sel.value = cfg.sim_scenario;
    sel.disabled = cfg.data_mode !== "simulated";

    // verdict
    $("verdict").dataset.color = dx.color;
    $("verdictLabel").textContent = dx.label;
    $("verdictReason").textContent = dx.reason;
    $("verdictAdvice").textContent = dx.advice;
    $("prNum").textContent = dx.efficiency === null ? "—" : `${fmt(dx.efficiency)}%`;
    document.querySelectorAll(".scale span").forEach((s) => s.classList.toggle("on", s.dataset.s === dx.state));

    // solar
    $("pvW").textContent = fmt(r.pv_watts);
    $("pvExp").textContent = `${fmt(r.expected_pv_watts)} W`;
    $("pvVA").textContent = `${fmt(r.pv_volts, 1)} V · ${fmt(r.pv_amps, 2)} A`;
    $("irr").textContent = `${fmt(r.irradiance_wm2)} W/m²`;
    const rated = cfg.panel_rated_watts || 1;
    $("pvBar").style.width = `${Math.min(100, ((r.pv_watts || 0) / rated) * 100)}%`;
    $("expMark").style.left = `${Math.min(100, ((r.expected_pv_watts || 0) / rated) * 100)}%`;

    // battery
    const soc = r.bat_soc ?? 0;
    $("soc").textContent = fmt(r.bat_soc);
    const ring = $("socRing");
    ring.style.strokeDasharray = `${soc} 100`;
    ring.style.stroke = soc <= cfg.dod_floor_pct + 10 ? "var(--red)" : soc < 50 ? "var(--yellow)" : "var(--green)";
    $("floorMark").style.transform = `rotate(${(cfg.dod_floor_pct / 100) * 360}deg)`;
    $("batV").textContent = `${fmt(r.bat_volts, 2)} V`;
    $("dod").textContent = `${fmt(cfg.dod_floor_pct)}%`;

    // load
    $("loadW").textContent = fmt(r.load_watts);
    $("temp").textContent = `${fmt(r.ambient_temp_c, 1)} °C`;
    $("wsrc").textContent = { "open-meteo": "Open-Meteo live", cache: "cached", model: "clear-sky model", sim: "simulated", seed: "seed" }[r.weather_source] || r.weather_source || "—";
    $("age").textContent = d.age_sec === null ? "—" : d.age_sec < 90 ? `${Math.round(d.age_sec)} s ago` : `${Math.round(d.age_sec / 60)} min ago`;

    // flow
    if (d.net) {
      $("flow").dataset.dir = d.net.direction;
      $("netW").textContent = `${d.net.watts > 0 ? "+" : ""}${fmt(d.net.watts)}`;
      $("flowLabel").textContent = { charging: "Charging battery", discharging: "Discharging battery", balanced: "Balanced" }[d.net.direction];
    }

    $("runtime").textContent = hrs(d.runtime_hours);
    $("runtimeCap").textContent = `at current ${fmt(r.load_watts)} W load · ${fmt(r.bat_soc)}% SoC`;
    renderWhatIf();
  }

  // ------------------------------------------------------------- what-if ---
  function shedWatts() {
    let w = Number($("custom").value);
    document.querySelectorAll("#appliances input:checked").forEach((c) => (w += Number(c.dataset.w)));
    return w;
  }

  function runtime(cfg, soc, load) {
    if (load <= 1) return null;
    return (cfg.battery_capacity_wh * Math.max(soc - cfg.dod_floor_pct, 0)) / 100 / load;
  }

  function renderWhatIf() {
    $("customVal").textContent = `${$("custom").value} W`;
    const d = state.live;
    if (!d || !d.reading) return;
    const cfg = d.config, r = d.reading;
    const shed = shedWatts();
    const newLoad = Math.max(r.load_watts - shed, 0);
    const base = runtime(cfg, r.bat_soc, r.load_watts);
    const next = runtime(cfg, r.bat_soc, newLoad);
    $("newLoad").textContent = `${fmt(newLoad)} W`;
    $("newRuntime").textContent = hrs(next);
    $("gain").textContent = shed === 0 ? "—" : next === null ? "∞" : `+${hrs(next - (base || 0))}`;
  }

  // ---------------------------------------------------------------- chart ---
  const css = getComputedStyle(document.documentElement);
  const c = (n) => css.getPropertyValue(n).trim();
  Chart.defaults.color = c("--muted");
  Chart.defaults.borderColor = c("--line");
  Chart.defaults.font.family = c("--sans");

  const chart = new Chart($("chart"), {
    type: "line",
    data: { datasets: [
      { label: "Actual PV (W)", data: [], borderColor: c("--sun"), backgroundColor: "rgba(245,179,1,.12)", fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
      { label: "Expected PV (W)", data: [], borderColor: c("--text"), borderDash: [5, 4], tension: .3, pointRadius: 0, borderWidth: 1.5 },
      { label: "Load (W)", data: [], borderColor: c("--blue"), tension: .3, pointRadius: 0, borderWidth: 1.5 },
      { label: "SoC (%)", data: [], borderColor: c("--green"), tension: .3, pointRadius: 0, borderWidth: 1.5, yAxisID: "soc" },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "linear", grid: { display: false },
             ticks: { maxTicksLimit: 8, maxRotation: 0, callback: (v) => {
               const t = new Date(v);
               return state.hours > 24 ? t.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
                                       : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
             } } },
        y: { beginAtZero: true, title: { display: true, text: "Watts" } },
        soc: { position: "right", min: 0, max: 100, grid: { display: false }, title: { display: true, text: "SoC %" } },
      },
      plugins: {
        legend: { labels: { boxWidth: 12, boxHeight: 2 } },
        tooltip: { callbacks: { title: (items) => items.length ? new Date(items[0].parsed.x).toLocaleString() : "" } },
      },
      spanGaps: 10 * 60 * 1000,
    },
  });

  async function loadHistory() {
    const rows = await api(`/api/history?hours=${state.hours}`);
    const xs = rows.map((r) => new Date(r.timestamp).getTime());
    const keys = ["pv_watts", "expected_pv_watts", "load_watts", "bat_soc"];
    keys.forEach((k, i) => (chart.data.datasets[i].data = rows.map((r, j) => ({ x: xs[j], y: r[k] }))));
    chart.options.scales.x.min = Date.now() - state.hours * 3600 * 1000;
    chart.options.scales.x.max = Date.now();
    chart.update();
  }

  // --------------------------------------------------------------- impact ---
  async function loadImpact() {
    state.impact = await api("/api/impact");
    renderImpact();
  }
  function renderImpact() {
    const i = state.impact && state.impact[state.impactKey];
    if (!i) return;
    $("kwh").textContent = fmt(i.kwh, 2);
    $("co2").textContent = fmt(i.co2_kg, 1);
    $("savings").textContent = `${i.currency}${fmt(i.savings, 2)}`;
    $("lost").textContent = fmt(i.lost_kwh, 2);
    const cfg = state.live?.config;
    if (cfg) $("impactNote").textContent = `At ${cfg.currency_symbol}${fmt(cfg.electricity_rate_kwh, 2)}/kWh and ${cfg.grid_emission_kg_kwh} kg CO₂/kWh grid emission factor.`;
  }

  // --------------------------------------------------------------- alerts ---
  async function loadAlerts() {
    const list = await api(`/api/alerts${state.showResolved ? "?all=1" : ""}`);
    const ul = $("alerts");
    ul.replaceChildren();
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No open alerts — system healthy.";
      ul.appendChild(li);
      return;
    }
    for (const a of list) {
      const li = document.createElement("li");
      li.className = "alert" + (a.is_resolved ? " resolved" : "");
      li.dataset.sev = a.severity;
      const cat = document.createElement("span");
      cat.className = "cat";
      cat.textContent = a.category.replace("_", " ");
      const body = document.createElement("div");
      body.textContent = a.message;
      const t = document.createElement("time");
      t.textContent = `${a.severity} · ${new Date(a.created_at).toLocaleString()}`;
      body.appendChild(t);
      li.append(cat, body);
      if (!a.is_resolved) {
        const btn = document.createElement("button");
        btn.className = "btn ghost";
        btn.textContent = "Resolve";
        btn.onclick = async () => { await api(`/api/alerts/${a.id}/resolve`, { method: "POST" }); loadAlerts(); };
        li.appendChild(btn);
      } else li.appendChild(document.createElement("span"));
      ul.appendChild(li);
    }
  }

  // ------------------------------------------------------------- controls ---
  document.querySelectorAll(".seg [data-mode]").forEach((b) => b.addEventListener("click", async () => {
    await api("/api/config", { method: "POST", body: { data_mode: b.dataset.mode } });
    toast(b.dataset.mode === "live" ? "Switched to live hardware bridge" : "Switched to simulated fault replay");
    tick();
  }));
  $("scenario").addEventListener("change", async (e) => {
    await api("/api/config", { method: "POST", body: { sim_scenario: e.target.value } });
    toast(`Scenario: ${e.target.selectedOptions[0].title}`);
    tick();
  });
  $("range").addEventListener("click", (e) => {
    const h = e.target.dataset.h;
    if (!h) return;
    state.hours = Number(h);
    $("range").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target));
    loadHistory();
  });
  $("impactRange").addEventListener("click", (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    state.impactKey = k;
    $("impactRange").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target));
    renderImpact();
  });
  $("showResolved").addEventListener("change", (e) => { state.showResolved = e.target.checked; loadAlerts(); });
  $("appliances").addEventListener("change", renderWhatIf);
  $("custom").addEventListener("input", renderWhatIf);

  const dlg = $("settings"), form = $("settingsForm");
  $("openSettings").addEventListener("click", async () => {
    const cfg = await api("/api/config");
    for (const el of form.elements) if (el.name && cfg[el.name] !== undefined) el.value = cfg[el.name];
    dlg.showModal();
  });
  form.addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      await api("/api/config", { method: "POST", body });
      dlg.close();
      toast("Configuration saved");
      tick(); loadImpact();
    } catch (err) { toast(`Save failed: ${err.message}`); }
  });

  // ---------------------------------------------------------------- loops ---
  async function tick() {
    try { renderLive(await api("/api/live")); }
    catch (err) {
      const badge = $("linkBadge");
      badge.dataset.state = "edge_syncing";
      badge.querySelector("b").textContent = "Server offline";
    }
  }

  tick(); loadHistory(); loadImpact(); loadAlerts();
  setInterval(tick, 3000);
  setInterval(() => { loadHistory(); loadAlerts(); }, 10000);
  setInterval(loadImpact, 30000);
})();
