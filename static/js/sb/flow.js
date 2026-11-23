// Power-flow schematic: SVG edges sized to their grid cell; dash speed ∝ wattage, direction = energy flow.

export function createFlow(root) {
  const edges = [...root.querySelectorAll(".sb-edge")];
  const nodes = Object.fromEntries([...root.querySelectorAll(".sb-node")].map((n) => [n.dataset.node, n]));

  function layout() {
    for (const svg of edges) {
      const { width: w, height: h } = svg.getBoundingClientRect();
      if (!w || !h) continue;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const vertical = h > w;
      for (const l of svg.querySelectorAll("line")) {
        if (vertical) { l.setAttribute("x1", w / 2); l.setAttribute("x2", w / 2); l.setAttribute("y1", 0); l.setAttribute("y2", h); }
        else { l.setAttribute("x1", 0); l.setAttribute("x2", w); l.setAttribute("y1", h / 2); l.setAttribute("y2", h / 2); }
      }
    }
  }
  new ResizeObserver(layout).observe(root);
  layout();

  // watts → seconds per dash cycle (faster with more power); quantised so CSS animations don't restart every tick
  const duration = (w) => Math.round(Math.min(3.2, Math.max(0.35, 520 / Math.max(w, 1))) * 20) / 20;

  function setEdge(name, watts, tone, reverse = false) {
    const svg = root.querySelector(`[data-edge="${name}"]`);
    const on = Math.abs(watts) >= 5;
    svg.dataset.on = on ? "1" : "0";
    svg.dataset.tone = tone;
    const dur = `${duration(Math.abs(watts))}s`, dir = reverse ? "reverse" : "normal";
    if (svg.style.getPropertyValue("--dur") !== dur) svg.style.setProperty("--dur", dur);
    if (svg.style.getPropertyValue("--dir") !== dir) svg.style.setProperty("--dir", dir);
  }

  return {
    update({ pv, load, soc, floor }) {
      const net = pv - load;                     // + charging, − discharging
      const critical = soc !== null && soc <= floor + 10 && net < 0;
      setEdge("pv", pv, "solar");
      setEdge("load", load, critical ? "coral" : "ink");
      setEdge("bat", net, "cobalt", net < 0);    // down = into battery, reversed = out of battery
      nodes.solar.dataset.active = pv >= 5 ? "solar" : "";
      nodes.load.dataset.active = critical ? "coral" : load >= 5 ? "ink" : "";
      nodes.battery.dataset.active = Math.abs(net) >= 5 ? "cobalt" : "";
      nodes.inverter.dataset.active = pv >= 5 || load >= 5 ? "ink" : "";
      return net;
    },
  };
}
