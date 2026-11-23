// Number interpolation: 400ms, cubic-bezier(0.16, 1, 0.3, 1). Tabular mono digits keep width stable.

export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 6; i++) {           // Newton–Raphson
      const err = sx(t) - x, d = dx(t);
      if (Math.abs(err) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}

export const ease = cubicBezier(0.16, 1, 0.3, 1);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const state = new Map(); // key -> { value, raf }

/** Animate a numeric value; `render(v)` is called every frame. */
export function tween(key, to, render, duration = 400) {
  if (to === null || to === undefined || Number.isNaN(to)) { render(null); state.delete(key); return; }
  const s = state.get(key) || { value: null, raf: 0 };
  cancelAnimationFrame(s.raf);
  const from = s.value;
  if (from === null || reduced || from === to) { s.value = to; state.set(key, s); render(to); return; }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    s.value = from + (to - from) * ease(p);
    render(s.value);
    if (p < 1) s.raf = requestAnimationFrame(step);
    else s.value = to;
  };
  s.raf = requestAnimationFrame(step);
  state.set(key, s);
}

/** Tween every [data-num=key] element (supports data-dec and data-sign). */
export function setNum(key, value) {
  const els = document.querySelectorAll(`[data-num="${key}"]`);
  if (!els.length) return;
  tween("num:" + key, value, (v) => {
    els.forEach((el) => {
      if (v === null) { el.textContent = "—"; return; }
      const dec = Number(el.dataset.dec || 0);
      const txt = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
      const sign = el.dataset.sign ? (v > 0.5 ? "+" : v < -0.5 ? "−" : "") : v < 0 ? "−" : "";
      el.textContent = sign + txt;
    });
  });
}

export function fmtHours(h, html = false) {
  if (h === null || h === undefined) return "∞";
  const H = Math.floor(h), M = Math.floor((h - H) * 60);
  const mm = String(M).padStart(2, "0");
  return html ? `${H}<small>h</small>${mm}<small>m</small>` : `${H}h ${mm}m`;
}
