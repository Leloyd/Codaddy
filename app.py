"""SolarBridge AI — Flask routes & REST API.

    python app.py            # dashboard on http://localhost:5000 (+ embedded poller)
"""
import logging
import os
from datetime import datetime, timedelta

from flask import Flask, Response, abort, jsonify, render_template, request

import db
import diagnostics
import simulator
from poller import Poller

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = Flask(__name__)
poller = Poller()


def _iso(row):
    if row is None:
        return None
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in row.items()}


def _today_start():
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


def live_snapshot():
    cfg = db.get_config()
    recent = poller.recent()
    latest = recent[-1] if recent else None
    age = (datetime.now() - latest["timestamp"]).total_seconds() if latest else None
    stale_after = max(cfg["poll_interval_sec"] * 3, 15)

    gateway_down = cfg["data_mode"] == "live" and poller.status["gateway"] == "disconnected"
    if latest is None or age > stale_after or gateway_down:
        link = {"state": "edge_syncing", "label": "Edge Syncing",
                "detail": "Hotspot unreachable — showing cached readings from local DB"}
    elif cfg["data_mode"] == "live":
        link = {"state": "live", "label": "Live Hardware", "detail": f"Polling {cfg['gateway_ip']}"}
    else:
        link = {"state": "simulated", "label": "Simulated Replay",
                "detail": simulator.SCENARIOS.get(cfg["sim_scenario"], cfg["sim_scenario"])}

    out = {"config": _iso(cfg), "link": link, "age_sec": age, "poller": poller.status,
           "reading": _iso(latest), "diagnosis": diagnostics.classify(recent)}
    if latest:
        out["net"] = diagnostics.net_flow(latest["pv_watts"], latest["load_watts"])
        out["runtime_hours"] = diagnostics.runtime_hours(
            cfg["battery_capacity_wh"], latest["bat_soc"], cfg["dod_floor_pct"], latest["load_watts"])
        # Daily loss estimate: current deficit fraction × what the array should make in a day
        day = db.query("SELECT timestamp, expected_pv_watts AS pv_watts FROM telemetry_logs "
                       "WHERE timestamp >= %s ORDER BY timestamp", (datetime.now() - timedelta(hours=24),))
        daily_expected = diagnostics.integrate_kwh(day) or cfg["panel_rated_watts"] * 4.5 * 0.9 / 1000
        eff = out["diagnosis"]["efficiency"]
        loss_kwh = daily_expected * max(0.0, 1 - eff / 100) if eff is not None else 0.0
        out["loss"] = {"daily_expected_kwh": round(daily_expected, 2), "daily_kwh": round(loss_kwh, 2),
                       "daily_money": round(loss_kwh * cfg["electricity_rate_kwh"], 2)}
    return out


# ------------------------------------------------------------------ pages ---

@app.route("/")
def index():
    return render_template("index.html", scenarios=simulator.SCENARIOS)


@app.route("/classic")
def classic():
    return render_template("classic.html", scenarios=simulator.SCENARIOS)


@app.route("/report")
def report():
    cfg = db.get_config()
    days = max(1, min(int(request.args.get("days", 7)), 90))
    since = datetime.now() - timedelta(days=days)
    rows = db.query("SELECT * FROM telemetry_logs WHERE timestamp >= %s ORDER BY timestamp", (since,))
    alerts = db.query("SELECT * FROM diagnostic_alerts WHERE created_at >= %s ORDER BY created_at DESC",
                      (since,))
    open_alerts = [a for a in alerts if not a["is_resolved"]]
    effs = [r["efficiency_pct"] for r in rows if r["efficiency_pct"] is not None]
    avg_eff = round(sum(effs) / len(effs), 1) if effs else None
    kwh = diagnostics.integrate_kwh(rows)
    lost = diagnostics.lost_kwh(rows)
    recent = rows[-30:]
    diag = diagnostics.classify(recent)

    actions = []
    cats = {a["category"] for a in open_alerts}
    if "FAULT" in cats:
        actions.append("URGENT: inspect PV isolator/breaker, string fuses and MC4 connectors for an open circuit.")
    if "SHADING" in cats:
        actions.append("Survey the array at the flagged hours for new shade sources; trim vegetation / relocate obstructions.")
    if "SOILING" in cats or (avg_eff and avg_eff < 88):
        actions.append(f"Clean panels — recovers an estimated {lost / days:.2f} kWh/day "
                       f"({cfg['currency_symbol']}{lost / days * cfg['electricity_rate_kwh']:.2f}/day).")
    if "LOW_BATTERY" in cats:
        actions.append("Battery repeatedly near DoD floor: review evening loads or add storage capacity.")
    if not actions:
        actions.append("No action required. Continue routine monthly visual inspection.")

    html = render_template(
        "report.html", cfg=cfg, days=days, generated=datetime.now(), diag=diag,
        health=diagnostics.health_score(avg_eff, open_alerts), avg_eff=avg_eff,
        impact=diagnostics.impact(kwh, cfg), lost_kwh=round(lost, 2),
        lost_money=round(lost * cfg["electricity_rate_kwh"], 2), alerts=alerts, actions=actions,
        readings=len(rows),
    )
    if request.args.get("download"):
        name = f"solarbridge-report-{datetime.now():%Y%m%d}.html"
        return Response(html, mimetype="text/html",
                        headers={"Content-Disposition": f"attachment; filename={name}"})
    return html


# -------------------------------------------------------------------- API ---

@app.route("/api/live")
@app.route("/api/telemetry")
def api_live():
    return jsonify(live_snapshot())


@app.route("/api/history")
def api_history():
    hours = max(0.05, min(float(request.args.get("hours", 6)), 168))
    rows = db.query("SELECT timestamp, pv_watts, expected_pv_watts, load_watts, bat_soc, efficiency_pct, "
                    "irradiance_wm2 FROM telemetry_logs WHERE timestamp >= %s ORDER BY timestamp",
                    (datetime.now() - timedelta(hours=hours),))
    step = max(1, len(rows) // 400)  # keep the chart light
    return jsonify([_iso(r) for r in rows[::step]])


@app.route("/api/impact")
def api_impact():
    cfg = db.get_config()
    out = {}
    for key, since in (("today", _today_start()), ("week", datetime.now() - timedelta(days=7)),
                       ("lifetime", datetime(2000, 1, 1))):
        rows = db.query("SELECT timestamp, pv_watts, expected_pv_watts, efficiency_pct FROM telemetry_logs "
                        "WHERE timestamp >= %s ORDER BY timestamp", (since,))
        out[key] = diagnostics.impact(diagnostics.integrate_kwh(rows), cfg)
        out[key]["lost_kwh"] = round(diagnostics.lost_kwh(rows), 2)
    return jsonify(out)


@app.route("/api/alerts")
def api_alerts():
    show_all = request.args.get("all") == "1"
    q = "SELECT * FROM diagnostic_alerts " + ("" if show_all else "WHERE is_resolved = 0 ")
    return jsonify([_iso(a) for a in db.query(q + "ORDER BY created_at DESC LIMIT 50")])


@app.route("/api/alerts/<int:alert_id>/resolve", methods=["POST"])
def api_resolve(alert_id):
    db.execute("UPDATE diagnostic_alerts SET is_resolved = 1 WHERE id = %s", (alert_id,))
    return jsonify({"ok": True})


@app.route("/api/config", methods=["GET", "POST"])
def api_config():
    if request.method == "POST":
        data = request.get_json(force=True) or {}
        if data.get("data_mode") not in (None, "live", "simulated"):
            abort(400, "data_mode must be live or simulated")
        if data.get("sim_scenario") not in (None, *simulator.SCENARIOS):
            abort(400, "unknown scenario")
        before = db.get_config()
        try:
            cfg = db.update_config(data)
        except (TypeError, ValueError) as e:
            abort(400, str(e))
        if (cfg["data_mode"], cfg["sim_scenario"]) != (before["data_mode"], before["sim_scenario"]):
            poller.epoch = datetime.now().replace(microsecond=0)
            try:
                poller.tick()  # fresh reading now, so the UI reacts instantly to a mode switch
            except Exception:
                logging.getLogger("solarbridge").exception("Immediate tick failed")
        return jsonify(_iso(cfg))
    return jsonify(_iso(db.get_config()))


@app.route("/api/runtime")
def api_runtime():
    """What-if: /api/runtime?shed=150 → extra backup hours from switching off 150 W."""
    cfg = db.get_config()
    latest = db.query_one("SELECT * FROM telemetry_logs ORDER BY id DESC LIMIT 1")
    if not latest:
        abort(404)
    shed = float(request.args.get("shed", 0))
    base = diagnostics.runtime_hours(cfg["battery_capacity_wh"], latest["bat_soc"], cfg["dod_floor_pct"],
                                     latest["load_watts"])
    new = diagnostics.runtime_hours(cfg["battery_capacity_wh"], latest["bat_soc"], cfg["dod_floor_pct"],
                                    latest["load_watts"], shed)
    return jsonify({"base_hours": base, "new_hours": new, "load_watts": latest["load_watts"], "shed": shed})


@app.route("/api/heatmap")
def api_heatmap():
    days = max(1, min(int(request.args.get("days", 7)), 31))
    today = datetime.now().date()
    since = datetime.combine(today - timedelta(days=days - 1), datetime.min.time())
    rows = db.query("SELECT timestamp, efficiency_pct, irradiance_wm2 FROM telemetry_logs "
                    "WHERE timestamp >= %s ORDER BY timestamp", (since,))
    return jsonify(diagnostics.efficiency_heatmap(rows, days, range(6, 19), today))


@app.route("/api/uptime")
def api_uptime():
    hours = max(1, min(int(request.args.get("hours", 24)), 168))
    end = datetime.now().replace(microsecond=0)
    start = end - timedelta(hours=hours)
    rows = db.query("SELECT timestamp, source FROM telemetry_logs WHERE timestamp >= %s ORDER BY timestamp",
                    (start - diagnostics.MAX_GAP,))
    res = diagnostics.uptime_buckets(rows, start, end, bucket=timedelta(minutes=hours * 60 / 96))
    gaps = [b for b in res["buckets"] if b["status"] != "ok"]
    res.update(readings=sum(b["count"] for b in res["buckets"]),
               longest_gap_s=max((b["longest_gap_s"] for b in res["buckets"]), default=0),
               last_gap=_iso(gaps[-1])["start"] if gaps else None)
    res["buckets"] = [_iso(b) for b in res["buckets"]]
    return jsonify(res)


def create_app():
    db.init_db()
    simulator.write_demo_recording(db.get_config())
    poller.epoch = datetime.now().replace(microsecond=0)  # judge this session's readings, not old/seed history
    if os.environ.get("EMBEDDED_POLLER", "1") == "1":
        poller.start_thread()
    logging.getLogger("solarbridge").info("Storage backend: %s", db.BACKEND)
    return app


if __name__ == "__main__":
    create_app().run(host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", 5000)),
                     debug=False, threaded=True)
