"""Background worker: scrape the inverter's local hotspot + Open-Meteo, store, diagnose.

Run standalone:  python poller.py
Or embedded in the Flask app (default; disable with EMBEDDED_POLLER=0).
"""
import logging
import re
import threading
import time
from datetime import datetime, timedelta

import requests

import db
import diagnostics
import simulator

log = logging.getLogger("solarbridge.poller")

# Field aliases seen on common inverter / BMS Wi-Fi dongles (lower-cased, punctuation stripped)
ALIASES = {
    "pv_volts": ["pvvoltage", "pvvolts", "vpv", "pvv", "pv1voltage", "pvinputvoltage", "solarvoltage"],
    "pv_amps": ["pvcurrent", "pvamps", "ipv", "pvi", "pv1current", "pvinputcurrent", "solarcurrent"],
    "pv_watts": ["pvpower", "pvwatts", "ppv", "pvw", "pv1power", "pvinputpower", "solarpower"],
    "bat_volts": ["batteryvoltage", "batvoltage", "vbat", "batv", "batvolts", "battvoltage"],
    "bat_soc": ["soc", "batterysoc", "batsoc", "batterycapacity", "stateofcharge", "batterypercent"],
    "load_watts": ["loadpower", "loadwatts", "pload", "acoutputactivepower", "outputpower", "loadw"],
}

WEATHER_TTL = timedelta(minutes=10)
ALERT_COOLDOWN = timedelta(minutes=30)


def _norm(key):
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _flatten(obj, out=None):
    out = {} if out is None else out
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                _flatten(v, out)
            else:
                out.setdefault(_norm(k), v)
    elif isinstance(obj, list):
        for v in obj:
            _flatten(v, out)
    return out


def _num(v):
    try:
        return float(re.findall(r"-?\d+(?:\.\d+)?", str(v))[0])
    except (IndexError, ValueError):
        return None


def parse_gateway_payload(text):
    """Map a JSON (or label:value HTML) payload from the dongle onto our fields."""
    flat = {}
    try:
        import json
        flat = _flatten(json.loads(text))
    except ValueError:
        # HTML fallback: "PV Voltage: 36.4 V" / <td>PV Voltage</td><td>36.4</td>
        plain = re.sub(r"<[^>]+>", "\n", text)
        for m in re.finditer(r"([A-Za-z][A-Za-z0-9 _]{0,30}?)[ \t]*[:=]?\s*(-?\d+(?:\.\d+)?)", plain):
            flat.setdefault(_norm(m.group(1)), m.group(2))
    out = {}
    for field, names in ALIASES.items():
        for n in names:
            if n in flat and _num(flat[n]) is not None:
                out[field] = _num(flat[n])
                break
    if "pv_watts" not in out and {"pv_volts", "pv_amps"} <= out.keys():
        out["pv_watts"] = out["pv_volts"] * out["pv_amps"]
    if "pv_amps" not in out and out.get("pv_volts") and "pv_watts" in out:
        out["pv_amps"] = out["pv_watts"] / out["pv_volts"]
    return out


class Poller:
    def __init__(self):
        self.status = {"gateway": "unknown", "weather": "unknown", "last_error": None,
                       "last_poll": None, "last_gateway_ok": None, "running": False}
        self._sim = None
        self._sim_key = None
        self._weather = None
        self._weather_at = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self.epoch = None  # set on data-source/scenario switch so diagnosis reacts instantly

    # ------------------------------------------------------------ sources --
    def fetch_gateway(self, cfg):
        path = cfg["gateway_path"] if cfg["gateway_path"].startswith("/") else "/" + cfg["gateway_path"]
        url = f"http://{cfg['gateway_ip']}{path}"
        resp = requests.get(url, timeout=3)
        resp.raise_for_status()
        data = parse_gateway_payload(resp.text)
        if "pv_watts" not in data and "bat_soc" not in data:
            raise ValueError(f"No recognisable telemetry fields at {url}")
        return data

    def fetch_weather(self, cfg):
        now = datetime.now()
        if self._weather and self._weather_at and now - self._weather_at < WEATHER_TTL:
            return self._weather, "cache"
        try:
            resp = requests.get("https://api.open-meteo.com/v1/forecast", timeout=5, params={
                "latitude": cfg["latitude"], "longitude": cfg["longitude"],
                "current": "global_tilted_irradiance,temperature_2m,cloud_cover",
                "tilt": cfg["panel_tilt"], "azimuth": cfg["panel_azimuth"], "timezone": "auto",
            })
            resp.raise_for_status()
            cur = resp.json()["current"]
            self._weather = {"irradiance_wm2": cur["global_tilted_irradiance"],
                             "ambient_temp_c": cur["temperature_2m"],
                             "cloud_cover": cur.get("cloud_cover")}
            self._weather_at = now
            self.status["weather"] = "online"
            return self._weather, "open-meteo"
        except Exception as e:  # internet down: keep working on cached / modelled weather
            log.warning("Open-Meteo unavailable: %s", e)
            self.status["weather"] = "offline"
            if self._weather:
                return self._weather, "cache"
            g, t = simulator.Simulator(cfg, realtime_sun=True).sun(now)
            return {"irradiance_wm2": round(g, 1), "ambient_temp_c": round(t, 1)}, "model"

    def simulator_for(self, cfg):
        key = cfg["sim_scenario"]
        if self._sim is None or self._sim_key != key:
            soc = self._sim.soc if self._sim else 78.0
            if key == "brownout" and soc < 60:
                soc = 85.0
            self._sim = simulator.Simulator(cfg, scenario=key, soc=soc)
            self._sim_key = key
        self._sim.cfg = cfg
        return self._sim

    # --------------------------------------------------------------- tick --
    def tick(self):
        with self._lock:
            return self._tick()

    def recent(self, limit=30):
        """Newest readings (oldest → newest), cut at the last mode switch."""
        rows = db.query("SELECT * FROM telemetry_logs ORDER BY id DESC LIMIT %s", (limit,))[::-1]
        if self.epoch:
            rows = [r for r in rows if r["timestamp"] >= self.epoch] or rows[-1:]
        return rows

    def _tick(self):
        cfg = db.get_config()
        now = datetime.now().replace(microsecond=0)
        self.status["last_poll"] = now.isoformat()

        if cfg["data_mode"] == "live":
            try:
                reading = self.fetch_gateway(cfg)
                self.status.update(gateway="connected", last_error=None, last_gateway_ok=now.isoformat())
            except Exception as e:
                # Hotspot dropped: write nothing; dashboard serves cached DB rows ("Edge Syncing")
                self.status.update(gateway="disconnected", last_error=str(e))
                log.info("Gateway unreachable: %s", e)
                return None
            weather, wsrc = self.fetch_weather(cfg)
            reading.update(timestamp=now, irradiance_wm2=weather["irradiance_wm2"],
                           ambient_temp_c=weather["ambient_temp_c"], source="live", weather_source=wsrc)
            simulator.record(reading)
        else:
            reading = self.simulator_for(cfg).step(now, dt_sec=cfg["poll_interval_sec"])
            reading.update(source="replay" if cfg["sim_scenario"] == "recorded" else "sim",
                           weather_source="sim")
            self.status.update(gateway="simulated", last_error=None, last_gateway_ok=now.isoformat())

        reading["expected_pv_watts"] = diagnostics.expected_pv_watts(
            reading.get("irradiance_wm2"), reading.get("ambient_temp_c"), cfg["panel_rated_watts"])
        reading["efficiency_pct"] = (None if diagnostics.curtailed(reading) else
                                     diagnostics.efficiency_pct(reading.get("pv_watts"), reading["expected_pv_watts"]))
        db.insert_telemetry(reading)
        self.run_rules(cfg)
        return reading

    # -------------------------------------------------------------- rules --
    def run_rules(self, cfg):
        recent = self.recent()
        verdict = diagnostics.classify(recent)
        latest = recent[-1]
        severity = {"FAULT": "CRITICAL", "SHADING": "WARNING", "SOILING": "WARNING"}
        if verdict["state"] in severity and verdict["confidence"] >= 0.65:
            msg = verdict["reason"] + " " + verdict["advice"]
            if verdict["state"] == "SOILING":
                today = db.query("SELECT * FROM telemetry_logs WHERE timestamp >= %s ORDER BY timestamp",
                                 (datetime.now().replace(hour=0, minute=0, second=0),))
                msg += f" Estimated {diagnostics.lost_kwh(today):.2f} kWh lost so far today."
            self.raise_alert(severity[verdict["state"]], verdict["state"], msg)
        floor = cfg["dod_floor_pct"]
        if latest.get("bat_soc") is not None and latest["bat_soc"] <= floor + 10:
            hrs = diagnostics.runtime_hours(cfg["battery_capacity_wh"], latest["bat_soc"], floor,
                                            latest.get("load_watts"))
            self.raise_alert("CRITICAL" if latest["bat_soc"] <= floor + 3 else "WARNING", "LOW_BATTERY",
                             f"Battery at {latest['bat_soc']:.0f}% (floor {floor:.0f}%). "
                             f"~{hrs or 0:.1f} h of backup left at current load — shed non-essential loads.")

    def raise_alert(self, severity, category, message):
        dup = db.query_one(
            "SELECT id FROM diagnostic_alerts WHERE category = %s AND is_resolved = 0 AND created_at >= %s",
            (category, datetime.now() - ALERT_COOLDOWN))
        if not dup:
            db.execute("INSERT INTO diagnostic_alerts (created_at, severity, category, message, is_resolved) "
                       "VALUES (%s, %s, %s, %s, 0)",
                       (datetime.now().replace(microsecond=0), severity, category, message[:500]))

    # --------------------------------------------------------------- loop --
    def run(self):
        self.status["running"] = True
        while not self._stop.is_set():
            started = time.monotonic()
            interval = 5
            try:
                interval = max(2, int(db.get_config()["poll_interval_sec"]))
                self.tick()
            except Exception:
                log.exception("Poll tick failed")
            self._stop.wait(max(0.5, interval - (time.monotonic() - started)))
        self.status["running"] = False

    def start_thread(self):
        t = threading.Thread(target=self.run, name="solarbridge-poller", daemon=True)
        t.start()
        return t

    def stop(self):
        self._stop.set()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db.init_db()
    simulator.write_demo_recording(db.get_config())
    Poller().run()
