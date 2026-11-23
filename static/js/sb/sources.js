// Data sources with one interface. ApiSource binds to the Flask backend (/api/telemetry …);
// MockSource is a realistic in-browser stream so the UI is alive with no backend at all.

export class ApiSource {
  kind = "api";
  async #j(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" }, ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }
  snapshot() { return this.#j("/api/telemetry"); }
  history(hours) { return this.#j(`/api/history?hours=${hours}`); }
  impact() { return this.#j("/api/impact"); }
  alerts(all) { return this.#j(`/api/alerts${all ? "?all=1" : ""}`); }
  resolve(id) { return this.#j(`/api/alerts/${id}/resolve`, { method: "POST" }); }
  getConfig() { return this.#j("/api/config"); }
  setConfig(body) { return this.#j("/api/config", { method: "POST", body }); }
  heatmap() { return this.#j("/api/heatmap?days=7"); }
  uptime() { return this.#j("/api/uptime?hours=24"); }
}

// ───────────────────────────────────────────────────────────── mock stream ──
const STATES = {
  OPTIMAL: { label: "Optimal", color: "green", advice: "Array is producing within 85–100% of weather-adjusted capacity." },
  SOILING: { label: "Soiling / Dust", color: "yellow", advice: "Steady 10–25% deficit in clear sky. Clean the panels (early morning, soft brush + water)." },
  SHADING: { label: "Shading Anomaly", color: "orange", advice: "PV current dropped sharply while voltage held. Check for new obstructions: trees, antennas, laundry, debris." },
  FAULT: { label: "Hardware / String Fault", color: "red", advice: "Near-zero PV output despite strong sun. Inspect PV breaker, MC4 connectors, fuses and string wiring." },
  IDLE: { label: "Low Light", color: "slate", advice: "Not enough sunlight to judge array performance." },
};
const rnd = (a, b) => a + Math.random() * (b - a);

function expected(g, ta, rated) {
  if (g <= 0) return 0;
  const tc = ta + (g / 800) * 25;
  return Math.max(0, rated * (g / 1000) * (1 - 0.004 * (tc - 25)) * 0.9);
}

export class MockSource {
  kind = "mock";
  cfg = {
    site_name: "Barangay Health Center", gateway_ip: "192.168.4.1", gateway_path: "/status", poll_interval_sec: 3,
    panel_rated_watts: 1000, panel_tilt: 15, panel_azimuth: 0, battery_capacity_wh: 2560, battery_nominal_v: 25.6,
    dod_floor_pct: 20, electricity_rate_kwh: 12.5, currency_symbol: "₱", grid_emission_kg_kwh: 0.709,
    latitude: 14.5995, longitude: 120.9842, data_mode: "simulated", sim_scenario: "optimal",
  };
  soc = 84; n = 0; rows = []; alertsList = []; nextId = 1; window = [];

  constructor() {
    // 7 days of 5-minute history: dust builds up over the week, tree shade every day 15:00–16:00
    const now = Date.now(), start = now - 7 * 864e5;
    let soc = 55;
    for (let t = start; t < now - 3e3; t += 300e3) {
      const d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
      const s = Math.max(0, Math.sin((Math.PI * (h - 6)) / 12));
      const g = 950 * s * (1 - 0.2 * Math.max(0, Math.sin(t / 7e6)) ** 6), ta = 27 + 6 * s;
      const exp = expected(g, ta, this.cfg.panel_rated_watts);
      const pv = exp * (1 - 0.13 * ((t - start) / (now - start))) * (d.getHours() === 15 ? 0.58 : 1) * rnd(0.98, 1.02);
      const load = (h >= 18 && h <= 22 ? 420 : 210) + rnd(-15, 15);
      soc = Math.min(100, Math.max(15, soc + ((pv - load) * 300) / 3600 / this.cfg.battery_capacity_wh * 100));
      this.rows.push(this.#row(new Date(t), g, ta, exp, pv, load, soc));
    }
    this.soc = Math.max(soc, 70);
    this.alertsList.push({ id: this.nextId++, created_at: new Date(now - 20 * 3600e3).toISOString(), severity: "WARNING",
      category: "SOILING", message: "Steady 12% output deficit on clear-sky readings. Estimated 0.6 kWh lost/day. Recommend cleaning panels.", is_resolved: 0 });
    this.#step();
  }

  #row(t, g, ta, exp, pv, load, soc, volts) {
    volts = volts ?? (g > 5 ? 36.5 * (1 - 0.0032 * (ta + (g / 800) * 25 - 25)) : 0);
    return {
      timestamp: t.toISOString(), irradiance_wm2: g, ambient_temp_c: ta, expected_pv_watts: exp, pv_watts: pv,
      pv_volts: volts, pv_amps: volts ? pv / volts : 0, load_watts: load, bat_soc: soc,
      bat_volts: 24 + (3.2 * soc) / 100 + (pv - load) / 2000,
      efficiency_pct: exp >= 50 ? Math.min(130, (pv / exp) * 100) : null, source: "mock", weather_source: "sim",
    };
  }

  #scenarioNow() {
    const s = this.cfg.sim_scenario;
    if (s !== "recorded") return s;
    return ["optimal", "shading", "fault"][Math.floor(this.n / 14) % 3];  // ~40 s per phase
  }

  #step() {
    this.n++;
    const sc = this.#scenarioNow(), cfg = this.cfg;
    const g = sc === "brownout" ? 0 : 860 + 40 * Math.sin(this.n / 15) + rnd(-10, 10);
    const ta = sc === "brownout" ? 27 : 32 + rnd(-0.4, 0.4);
    const exp = expected(g, ta, cfg.panel_rated_watts);
    let factor = { optimal: 0.97, soiling: 0.82 }[sc] ?? 0.97;
    if (sc === "shading") factor = Math.floor(this.n / 8) % 2 === 0 ? 0.5 : 0.96;
    let pv = exp * factor * rnd(0.985, 1.015), volts;
    if (sc === "fault") { pv = rnd(0, 3); volts = 44; }
    const load = sc === "brownout" ? 460 + rnd(-20, 20) : 310 + rnd(-12, 12) + (Math.random() < 0.04 ? 600 : 0);
    this.soc = Math.min(100, Math.max(5, this.soc + ((pv - load) * 3) / 3600 / cfg.battery_capacity_wh * 100 * 4)); // ×4: visible drift during a demo
    const r = this.#row(new Date(), g, ta, exp, pv, load, this.soc, volts);
    this.rows.push(r);
    this.window.push(r);
    if (this.window.length > 30) this.window.shift();
    if (this.rows.length > 4000) this.rows.splice(0, this.rows.length - 4000);
  }

  #classify() {
    const r = this.window[this.window.length - 1];
    const eff = r.efficiency_pct;
    if (r.irradiance_wm2 < 150 || eff === null) return { state: "IDLE", confidence: 1, efficiency: null, reason: "Irradiance below 150 W/m² — waiting for sun." };
    if (r.pv_amps < 0.3) return { state: "FAULT", confidence: 0.95, efficiency: eff, reason: `PV current ${r.pv_amps.toFixed(2)} A at ${r.irradiance_wm2.toFixed(0)} W/m² irradiance — string appears open (tripped breaker, loose MC4 or blown fuse).` };
    if (eff < 70) return { state: "SHADING", confidence: 0.85, efficiency: eff, reason: `PV current fell to ${r.pv_amps.toFixed(1)} A while voltage held at ${r.pv_volts.toFixed(1)} V and irradiance barely changed — partial shading.` };
    const lit = this.window.filter((x) => x.efficiency_pct !== null).map((x) => x.efficiency_pct);
    const med = lit.slice().sort((a, b) => a - b)[Math.floor(lit.length / 2)];
    if (med < 88) return { state: "SOILING", confidence: 0.8, efficiency: eff, reason: `Steady ${(100 - med).toFixed(0)}% deficit across ${lit.length} clear-sky readings — consistent with dust/soiling.` };
    return { state: "OPTIMAL", confidence: 0.9, efficiency: eff, reason: `Producing ${eff.toFixed(0)}% of weather-adjusted capacity.` };
  }

  #raise(d) {
    const sev = { FAULT: "CRITICAL", SHADING: "WARNING", SOILING: "WARNING" }[d.state];
    if (!sev) return;
    const recent = this.alertsList.find((a) => a.category === d.state && !a.is_resolved && Date.now() - new Date(a.created_at) < 30 * 60e3);
    if (!recent) this.alertsList.unshift({ id: this.nextId++, created_at: new Date().toISOString(), severity: sev, category: d.state, message: `${d.reason} ${STATES[d.state].advice}`, is_resolved: 0 });
  }

  async snapshot() {
    this.#step();
    const cfg = this.cfg, r = this.window[this.window.length - 1];
    const d = this.#classify();
    this.#raise(d);
    const net = r.pv_watts - r.load_watts;
    const usable = (cfg.battery_capacity_wh * Math.max(r.bat_soc - cfg.dod_floor_pct, 0)) / 100;
    const dailyExp = cfg.panel_rated_watts * 4.6 * 0.9 / 1000;
    const lossKwh = d.efficiency === null ? 0 : dailyExp * Math.max(0, 1 - d.efficiency / 100);
    const label = { optimal: "Healthy", soiling: "Dusty Panels", shading: "Shading Drop", fault: "String Fault", brownout: "Night Brownout", recorded: "Recorded Stream" }[cfg.sim_scenario];
    return {
      config: { ...cfg }, age_sec: 0, poller: { gateway: "mock", last_error: null },
      link: cfg.data_mode === "live"
        ? { state: "edge_syncing", label: "Edge Syncing", detail: "Mock stream: no backend reachable" }
        : { state: "mock", label: "Mock stream", detail: label },
      reading: r, diagnosis: { ...d, ...STATES[d.state] },
      net: { watts: net, direction: net > 5 ? "charging" : net < -5 ? "discharging" : "balanced" },
      runtime_hours: r.load_watts > 1 ? usable / r.load_watts : null,
      loss: { daily_expected_kwh: dailyExp, daily_kwh: lossKwh, daily_money: lossKwh * cfg.electricity_rate_kwh },
    };
  }

  async history(hours) {
    const since = Date.now() - hours * 3600e3;
    const rows = this.rows.filter((r) => new Date(r.timestamp).getTime() >= since);
    const step = Math.max(1, Math.floor(rows.length / 400));
    return rows.filter((_, i) => i % step === 0);
  }

  async impact() {
    const integ = (rows, key) => {
      let wh = 0;
      for (let i = 1; i < rows.length; i++) {
        const dt = (new Date(rows[i].timestamp) - new Date(rows[i - 1].timestamp)) / 3600e3;
        if (dt > 0 && dt <= 1 / 6) wh += ((key(rows[i]) + key(rows[i - 1])) / 2) * dt;
      }
      return wh / 1000;
    };
    const out = {}, midnight = new Date().setHours(0, 0, 0, 0);
    for (const [k, since] of [["today", midnight], ["week", Date.now() - 7 * 864e5], ["lifetime", 0]]) {
      const rows = this.rows.filter((r) => new Date(r.timestamp).getTime() >= since);
      const kwh = integ(rows, (r) => r.pv_watts);
      out[k] = { kwh, co2_kg: kwh * this.cfg.grid_emission_kg_kwh, savings: kwh * this.cfg.electricity_rate_kwh,
        currency: this.cfg.currency_symbol, lost_kwh: integ(rows, (r) => (r.efficiency_pct === null ? 0 : Math.max(0, r.expected_pv_watts - r.pv_watts))) };
    }
    return out;
  }

  async heatmap() {
    const days = [], cells = [], hours = Array.from({ length: 13 }, (_, i) => i + 6);
    const acc = new Map();
    for (const r of this.rows) {
      if (r.efficiency_pct === null || r.irradiance_wm2 < 150) continue;
      const t = new Date(r.timestamp), k = `${t.toDateString()}|${t.getHours()}`;
      const a = acc.get(k) || [0, 0]; a[0] += r.efficiency_pct; a[1]++; acc.set(k, a);
    }
    for (let d = 6; d >= 0; d--) {
      const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - d);
      days.push(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`);
      cells.push(hours.map((h) => { const a = acc.get(`${day.toDateString()}|${h}`); return a ? { eff: a[0] / a[1], n: a[1] } : null; }));
    }
    return { days, hours, cells };
  }

  async uptime() {
    const end = Date.now(), span = 24 * 3600e3, step = span / 96, buckets = [];
    const ts = this.rows.map((r) => [new Date(r.timestamp).getTime(), r.source]);
    for (let i = 0; i < 96; i++) {
      const a = end - span + i * step, b = a + step;
      const inside = ts.filter(([t]) => t >= a && t < b);
      buckets.push({ start: new Date(a).toISOString(), status: inside.length ? "ok" : "gap", count: inside.length,
        longest_gap_s: inside.length ? 300 : Math.round(step / 1000), source: inside.length ? inside[inside.length - 1][1] : null });
    }
    const ok = buckets.filter((x) => x.status === "ok").length;
    const gaps = buckets.filter((x) => x.status !== "ok");
    return { buckets, uptime_pct: (ok / 96) * 100, readings: buckets.reduce((s, x) => s + x.count, 0),
      longest_gap_s: Math.max(0, ...gaps.map((x) => x.longest_gap_s)), last_gap: gaps.length ? gaps[gaps.length - 1].start : null };
  }

  async alerts(all) { return this.alertsList.filter((a) => all || !a.is_resolved); }
  async resolve(id) { const a = this.alertsList.find((x) => x.id === id); if (a) a.is_resolved = 1; return { ok: true }; }
  async getConfig() { return { ...this.cfg }; }
  async setConfig(body) {
    const changed = (body.sim_scenario && body.sim_scenario !== this.cfg.sim_scenario) || (body.data_mode && body.data_mode !== this.cfg.data_mode);
    for (const [k, v] of Object.entries(body)) if (v !== "" && v !== null && k in this.cfg) this.cfg[k] = typeof this.cfg[k] === "number" ? Number(v) : v;
    if (changed) { this.window = []; this.n = 0; if (this.cfg.sim_scenario === "brownout" && this.soc < 60) this.soc = 86; }
    return { ...this.cfg };
  }
}
