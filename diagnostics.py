"""Expected-yield physics, the "Why is power low?" classifier, runtime and impact math.

Pure functions only — no DB or network — so they are easy to unit test.
"""
from datetime import timedelta
from statistics import median, pstdev

# Module / system constants (typical mono-Si values)
TEMP_COEFF = -0.004      # Pmax change per °C above 25 °C cell temp
NOCT = 45.0              # nominal operating cell temp, °C
SYSTEM_DERATE = 0.90     # wiring + MPPT + mismatch losses on a clean, healthy array
MIN_IRRADIANCE = 150.0   # below this, efficiency ratios are too noisy to judge

STATES = {
    "OPTIMAL": {"color": "green", "label": "Optimal",
                "advice": "Array is producing within 85–100% of weather-adjusted capacity."},
    "SOILING": {"color": "yellow", "label": "Soiling / Dust",
                "advice": "Steady 10–25% deficit in clear sky. Clean the panels (early morning, soft brush + water)."},
    "SHADING": {"color": "orange", "label": "Shading Anomaly",
                "advice": "PV current dropped sharply while voltage held. Check for new obstructions: trees, antennas, laundry, debris."},
    "FAULT": {"color": "red", "label": "Hardware / String Fault",
              "advice": "Near-zero PV output despite strong sun. Inspect PV breaker, MC4 connectors, fuses and string wiring."},
    "IDLE": {"color": "slate", "label": "Low Light",
             "advice": "Not enough sunlight to judge array performance (night, dawn/dusk or heavy overcast)."},
}


def cell_temp(ambient_c, irradiance):
    return ambient_c + irradiance / 800.0 * (NOCT - 20.0)


def expected_pv_watts(irradiance, ambient_c, rated_watts):
    """Theoretical array output for the current weather."""
    if irradiance is None or irradiance <= 0:
        return 0.0
    ambient_c = 30.0 if ambient_c is None else ambient_c
    temp_factor = 1 + TEMP_COEFF * (cell_temp(ambient_c, irradiance) - 25.0)
    return round(max(0.0, rated_watts * (irradiance / 1000.0) * temp_factor * SYSTEM_DERATE), 1)


def efficiency_pct(actual, expected):
    """Performance ratio vs. weather-adjusted expectation (None when too dark to judge)."""
    if not expected or expected < 50 or actual is None:
        return None
    return round(min(actual / expected * 100.0, 130.0), 1)


def classify(readings):
    """Classify array health from recent readings (oldest → newest).

    Returns {"state", "confidence", "reason", "efficiency", ...STATES[state]}.
    Rules are checked from most to least severe.
    """
    lit = [r for r in readings if (r.get("irradiance_wm2") or 0) >= MIN_IRRADIANCE
           and r.get("efficiency_pct") is not None]
    if not readings or not lit or lit[-1] is not readings[-1]:
        return _result("IDLE", 1.0, "Irradiance below %d W/m² — waiting for sun." % MIN_IRRADIANCE, None)

    latest = lit[-1]
    eff = latest["efficiency_pct"]
    g = latest["irradiance_wm2"]
    amps = latest.get("pv_amps") or 0.0
    volts = latest.get("pv_volts") or 0.0
    history = lit[:-1][-12:]
    v_ref = median([r["pv_volts"] for r in history if r.get("pv_volts")]) if history else volts

    # FAULT: almost nothing coming out of the array under strong sun, or voltage collapse
    if g >= 400 and (amps < 0.3 or eff < 10):
        return _result("FAULT", 0.95,
                       f"PV current {amps:.2f} A at {g:.0f} W/m² irradiance — string appears open "
                       "(tripped breaker, loose MC4 or blown fuse).", eff)
    if g >= 400 and v_ref and volts < 0.6 * v_ref:
        return _result("FAULT", 0.8,
                       f"PV voltage collapsed to {volts:.1f} V from a {v_ref:.1f} V baseline — "
                       "possible bypass-diode/cell failure or partial string disconnect.", eff)

    # SHADING: sharp current drop with stable voltage, not explained by irradiance
    if history:
        recent = history[-6:]
        a_ref = median([r.get("pv_amps") or 0 for r in recent])
        g_ref = median([r["irradiance_wm2"] for r in recent])
        current_drop = 1 - amps / a_ref if a_ref else 0
        irr_drop = 1 - g / g_ref if g_ref else 0
        volt_stable = v_ref and abs(volts - v_ref) / v_ref < 0.12
        if current_drop > 0.25 and current_drop - irr_drop > 0.2 and volt_stable and eff < 85:
            return _result("SHADING", 0.85,
                           f"PV current fell {current_drop * 100:.0f}% (to {amps:.1f} A) while voltage held at "
                           f"{volts:.1f} V and irradiance barely changed — partial shading.", eff)
    if eff < 70 and v_ref and abs(volts - v_ref) / v_ref < 0.12:
        return _result("SHADING", 0.65,
                       f"Output at {eff:.0f}% of expected with stable voltage — likely partial shading.", eff)

    # SOILING: steady, modest deficit across clear-sky readings
    window = [r["efficiency_pct"] for r in lit[-24:] if r["irradiance_wm2"] >= 400]
    if len(window) >= 4:
        med, spread = median(window), pstdev(window)
        if 70 <= med < 88 and spread < 6:
            return _result("SOILING", 0.8,
                           f"Steady {100 - med:.0f}% deficit (±{spread:.1f}%) across {len(window)} clear-sky "
                           "readings — consistent with dust/soiling.", eff)

    if eff >= 85:
        return _result("OPTIMAL", 0.9, f"Producing {eff:.0f}% of weather-adjusted capacity.", eff)
    return _result("SOILING", 0.5,
                   f"Output at {eff:.0f}% of expected. Gathering more clear-sky readings to confirm cause.", eff)


def _result(state, confidence, reason, eff):
    return {"state": state, "confidence": confidence, "reason": reason, "efficiency": eff, **STATES[state]}


# ----------------------------------------------------------- battery math ---

def runtime_hours(capacity_wh, soc_pct, dod_floor_pct, load_watts, shed_watts=0.0):
    """Remaining Hours = Capacity(Wh) × (SoC% − DoD floor%) / Load(W)."""
    load = max((load_watts or 0) - (shed_watts or 0), 0)
    usable_wh = capacity_wh * max((soc_pct or 0) - dod_floor_pct, 0) / 100.0
    if load <= 1:
        return None  # effectively unlimited
    return round(usable_wh / load, 2)


def net_flow(pv_watts, load_watts):
    net = (pv_watts or 0) - (load_watts or 0)
    return {"watts": round(net, 1),
            "direction": "charging" if net > 5 else "discharging" if net < -5 else "balanced"}


# --------------------------------------------------------- energy & impact ---

MAX_GAP = timedelta(minutes=10)  # do not integrate across outages / poller downtime


def integrate_kwh(rows, key="pv_watts"):
    """Trapezoidal integration of a watt series into kWh."""
    total = 0.0
    for a, b in zip(rows, rows[1:]):
        dt = b["timestamp"] - a["timestamp"]
        if timedelta(0) < dt <= MAX_GAP:
            total += ((a.get(key) or 0) + (b.get(key) or 0)) / 2 * dt.total_seconds() / 3600
    return total / 1000.0


def lost_kwh(rows):
    """Energy the array should have made but didn't (only counts lit, judged readings)."""
    total = 0.0
    for a, b in zip(rows, rows[1:]):
        dt = b["timestamp"] - a["timestamp"]
        if timedelta(0) < dt <= MAX_GAP and a.get("efficiency_pct") is not None:
            deficit = max((a.get("expected_pv_watts") or 0) - (a.get("pv_watts") or 0), 0)
            total += deficit * dt.total_seconds() / 3600
    return total / 1000.0


def impact(kwh, cfg):
    return {
        "kwh": round(kwh, 2),
        "co2_kg": round(kwh * cfg["grid_emission_kg_kwh"], 2),
        "savings": round(kwh * cfg["electricity_rate_kwh"], 2),
        "currency": cfg["currency_symbol"],
    }


def health_score(avg_eff, open_alerts):
    """0–100: performance ratio, minus penalties for unresolved alerts."""
    base = 100.0 if avg_eff is None else min(avg_eff, 100.0)
    penalty = sum({"CRITICAL": 25, "WARNING": 10, "INFO": 2}.get(a["severity"], 0) for a in open_alerts)
    return max(0, round(base - penalty))
