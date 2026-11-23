"""Synthetic telemetry + recorded-stream replay for the Demo Fail-Safe Mode."""
import glob
import json
import math
import os
import random
from datetime import datetime

import diagnostics

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RECORDINGS_DIR = os.path.join(BASE_DIR, "recordings")
DEMO_RECORDING = os.path.join(RECORDINGS_DIR, "demo_fault_replay.jsonl")

# scenario -> (array output factor vs. expected, description)
SCENARIOS = {
    "optimal": "Clean array, clear sky",
    "soiling": "Dusty panels: steady ~18% deficit",
    "shading": "Intermittent partial shade (current drops, voltage holds)",
    "fault": "Open string: near-zero current under full sun",
    "brownout": "Night-time grid outage, heavy load on battery",
    "recorded": "Replay recorded data stream (recordings/*.jsonl)",
}

VMP = 36.5   # array max-power voltage at 25 °C
VOC = 44.0   # array open-circuit voltage


class Simulator:
    def __init__(self, cfg, scenario="optimal", realtime_sun=False, soc=78.0):
        self.cfg = cfg
        self.scenario = scenario
        self.realtime_sun = realtime_sun
        self.soc = soc
        self.n = 0
        self._replay = None
        self._replay_idx = 0

    # --- weather ---------------------------------------------------------
    def sun(self, t):
        if self.scenario == "brownout":
            return 0.0, 27.0
        if self.realtime_sun:
            hour = t.hour + t.minute / 60
            s = max(0.0, math.sin(math.pi * (hour - 6) / 12))
            cloud = 1 - 0.25 * max(0, math.sin(t.timetuple().tm_yday * 7 + hour * 1.3)) ** 4
            return 950 * s * cloud, 27 + 6 * s
        # Demo sun: always near solar noon so judging works at any hour
        g = 860 + 40 * math.sin(self.n / 15) + random.uniform(-10, 10)
        return g, 32 + random.uniform(-0.5, 0.5)

    # --- one reading -----------------------------------------------------
    def step(self, t=None, dt_sec=5):
        t = t or datetime.now()
        self.n += 1
        if self.scenario == "recorded":
            return self._replay_step(t, dt_sec)

        cfg = self.cfg
        g, temp = self.sun(t)
        expected = diagnostics.expected_pv_watts(g, temp, cfg["panel_rated_watts"])
        volts = (VMP * (1 + diagnostics.TEMP_COEFF * 0.8 * (diagnostics.cell_temp(temp, g) - 25))
                 if g > 5 else 0.0)

        factor = {"optimal": 0.97, "soiling": 0.82, "soiling_mild": 0.87}.get(self.scenario, 0.97)
        if self.scenario == "shading" and (self.n // 12) % 2 == 0:
            factor = 0.5                               # shade passes over every minute
        pv_w = expected * factor * random.uniform(0.985, 1.015)
        if self.scenario == "fault":
            pv_w, volts = random.uniform(0, 3), VOC    # open circuit: Voc, ~0 A
        amps = pv_w / volts if volts else 0.0

        if self.scenario == "brownout":
            load = 460 + random.uniform(-25, 25)
        else:
            hour = t.hour
            base = 420 if (18 <= hour <= 22 and self.realtime_sun) else 210
            load = base + random.uniform(-15, 15) + (random.random() < 0.05) * 600  # kettle/iron spikes

        self.soc += (pv_w - load) * dt_sec / 3600 / cfg["battery_capacity_wh"] * 100
        self.soc = min(max(self.soc, 5.0), 100.0)
        if self.soc >= 100:
            pv_w = min(pv_w, load)                     # charge controller curtails when full
            amps = pv_w / volts if volts else 0.0
        bat_v = 24.0 + 3.2 * self.soc / 100 + (pv_w - load) / 2000

        return {
            "timestamp": t.replace(microsecond=0),
            "pv_watts": round(pv_w, 1), "pv_volts": round(volts, 2), "pv_amps": round(amps, 2),
            "bat_soc": round(self.soc, 1), "bat_volts": round(bat_v, 2),
            "load_watts": round(load, 1), "irradiance_wm2": round(g, 1), "ambient_temp_c": round(temp, 1),
        }

    # --- replay ----------------------------------------------------------
    def _replay_step(self, t, dt_sec):
        if self._replay is None:
            self._replay = load_recording()
        if not self._replay:
            self.scenario = "optimal"
            return self.step(t, dt_sec)
        r = dict(self._replay[self._replay_idx % len(self._replay)])
        self._replay_idx += 1
        r["timestamp"] = t.replace(microsecond=0)
        return r


def latest_recording():
    files = sorted(glob.glob(os.path.join(RECORDINGS_DIR, "*.jsonl")), key=os.path.getmtime)
    live = [f for f in files if os.path.basename(f).startswith("live-")]
    return (live or files or [None])[-1]


def load_recording(path=None):
    path = path or latest_recording()
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def record(reading):
    """Append a live reading to today's recording so it can be replayed later."""
    os.makedirs(RECORDINGS_DIR, exist_ok=True)
    path = os.path.join(RECORDINGS_DIR, f"live-{datetime.now():%Y%m%d}.jsonl")
    row = {k: v for k, v in reading.items() if k != "timestamp"}
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")


def write_demo_recording(cfg):
    """Bundled replay: 2 min optimal → 2 min shading → 2 min open-string fault (5 s ticks)."""
    if os.path.exists(DEMO_RECORDING):
        return
    os.makedirs(RECORDINGS_DIR, exist_ok=True)
    sim = Simulator(cfg, soc=72)
    rows = []
    for scenario, ticks in (("optimal", 24), ("shading", 24), ("fault", 24)):
        sim.scenario = scenario
        sim.n = 0
        for _ in range(ticks):
            r = sim.step()
            r.pop("timestamp")
            rows.append(r)
    with open(DEMO_RECORDING, "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r) + "\n" for r in rows)
