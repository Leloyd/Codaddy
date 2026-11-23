// Theoretical vs actual yield: dual-line area chart with a divergence fill and an HTML tooltip.
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const withAlpha = (hex, a) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export function createYieldChart(canvas, tipEl) {
  let hours = 6;
  let gapTone = "amber";
  let animateNext = true;   // animate on first paint and range changes only; live refreshes update in place

  const fmtTime = (ms) => {
    const t = new Date(ms);
    return hours > 24 ? t.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
                      : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  function externalTooltip({ chart, tooltip }) {
    if (!tooltip.opacity || !tooltip.dataPoints?.length) { tipEl.style.opacity = 0; return; }
    const p = tooltip.dataPoints;
    const exp = p.find((d) => d.datasetIndex === 0)?.parsed.y;
    const act = p.find((d) => d.datasetIndex === 1)?.parsed.y;
    const gap = exp > 50 && act !== undefined ? (act / exp) * 100 : null;
    const row = (k, v) => `<div class="r"><span>${k}</span><span>${v}</span></div>`;
    tipEl.innerHTML =
      `<div class="t">${new Date(p[0].parsed.x).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: hours <= 1 ? "2-digit" : undefined })}</div>` +
      row("Actual", act === undefined || act === null ? "—" : `${Math.round(act)} W`) +
      row("Expected", exp === undefined || exp === null ? "—" : `${Math.round(exp)} W`) +
      row("Ratio", gap === null ? "—" : `${gap.toFixed(1)}%`);
    const { offsetLeft: x0, offsetTop: y0 } = chart.canvas;
    const w = tipEl.offsetWidth, cw = chart.canvas.offsetWidth;
    let left = x0 + tooltip.caretX + 14;
    if (left + w > x0 + cw) left = x0 + tooltip.caretX - w - 14;
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${y0 + Math.max(4, tooltip.caretY - 40)}px`;
    tipEl.style.opacity = 1;
  }

  // vertical crosshair
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const a = chart.tooltip?.getActiveElements?.();
      if (!a?.length) return;
      const { ctx, chartArea } = chart, x = a[0].element.x;
      ctx.save();
      ctx.strokeStyle = css("--line-strong");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.restore();
    },
  };

  const chart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        { label: "Expected", data: [], borderWidth: 1.25, borderDash: [4, 4], pointRadius: 0, tension: 0.35, fill: "origin" },
        { label: "Actual", data: [], borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 3, tension: 0.35, fill: { target: 0 } },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400, easing: "easeOutQuart" },
      parsing: false, normalized: true, spanGaps: 10 * 60e3,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 6 } },
      scales: {
        x: { type: "linear", grid: { display: false }, border: { display: false },
             ticks: { maxTicksLimit: 7, maxRotation: 0, callback: (v) => fmtTime(v) } },
        y: { beginAtZero: true, border: { display: false }, ticks: { maxTicksLimit: 5, callback: (v) => `${v} W` } },
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false, external: externalTooltip } },
    },
    plugins: [crosshair],
  });

  function theme() {
    const mute = css("--mute"), line = css("--line"), solar = css("--solar");
    const gapColor = withAlpha(css(gapTone === "coral" ? "--coral" : "--amber"), gapTone === "coral" ? 0.16 : 0.2);
    Chart.defaults.font.family = "JetBrains Mono, ui-monospace, monospace";
    Chart.defaults.font.size = 11;
    const [exp, act] = chart.data.datasets;
    exp.borderColor = mute;
    exp.backgroundColor = withAlpha(css("--mute").startsWith("#") ? css("--mute") : "#71717A", 0.06);
    act.borderColor = solar;
    act.fill = { target: 0, above: withAlpha(solar, 0.08), below: gapColor };
    chart.options.scales.x.ticks.color = mute;
    chart.options.scales.y.ticks.color = mute;
    chart.options.scales.y.grid = { color: line, drawTicks: false };
    document.documentElement.style.setProperty("--gap", gapColor);
    chart.update("none");
  }
  theme();

  return {
    theme,
    setRange(h) { hours = h; animateNext = true; },
    setGapTone(tone) { if (tone !== gapTone) { gapTone = tone; theme(); } },
    setData(rows) {
      const xs = rows.map((r) => new Date(r.timestamp).getTime());
      chart.data.datasets[0].data = rows.map((r, i) => ({ x: xs[i], y: r.expected_pv_watts }));
      chart.data.datasets[1].data = rows.map((r, i) => ({ x: xs[i], y: r.pv_watts }));
      chart.options.scales.x.min = Date.now() - hours * 3600e3;
      chart.options.scales.x.max = Date.now();
      chart.update(animateNext ? undefined : "none");
      animateNext = false;
    },
  };
}
