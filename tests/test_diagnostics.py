from datetime import datetime, timedelta

import diagnostics as d
from poller import parse_gateway_payload


def reading(eff=97, g=850, amps=24.0, volts=36.0, t=None):
    exp = d.expected_pv_watts(g, 32, 1000)
    return {"timestamp": t or datetime.now(), "irradiance_wm2": g, "pv_amps": amps, "pv_volts": volts,
            "efficiency_pct": eff, "expected_pv_watts": exp, "pv_watts": exp * (eff or 0) / 100}


def test_expected_yield_scales_with_irradiance_and_heat():
    assert d.expected_pv_watts(0, 30, 1000) == 0
    hot, cool = d.expected_pv_watts(1000, 40, 1000), d.expected_pv_watts(1000, 20, 1000)
    assert hot < cool < 900


def test_runtime_formula_and_shedding():
    # 2560 Wh × (80 − 20)% / 400 W = 3.84 h
    assert d.runtime_hours(2560, 80, 20, 400) == 3.84
    assert d.runtime_hours(2560, 80, 20, 400, shed_watts=150) == round(1536 / 250, 2)
    assert d.runtime_hours(2560, 15, 20, 400) == 0
    assert d.runtime_hours(2560, 80, 20, 0) is None


def test_classify_states():
    assert d.classify([reading() for _ in range(10)])["state"] == "OPTIMAL"
    assert d.classify([reading(eff=82) for _ in range(10)])["state"] == "SOILING"
    shaded = [reading() for _ in range(8)] + [reading(eff=50, amps=12, volts=35.5)]
    assert d.classify(shaded)["state"] == "SHADING"
    fault = [reading() for _ in range(8)] + [reading(eff=0.3, amps=0.05, volts=44)]
    assert d.classify(fault)["state"] == "FAULT"
    assert d.classify([reading(g=40, eff=None)])["state"] == "IDLE"


def test_integrate_kwh_skips_gaps():
    t0 = datetime(2026, 1, 1, 12)
    rows = [{"timestamp": t0 + timedelta(minutes=5 * i), "pv_watts": 600} for i in range(13)]
    assert abs(d.integrate_kwh(rows) - 0.6) < 1e-9          # 600 W for 1 h
    rows.append({"timestamp": t0 + timedelta(hours=5), "pv_watts": 600})
    assert abs(d.integrate_kwh(rows) - 0.6) < 1e-9          # 4 h outage gap ignored


def test_parse_gateway_json_and_html():
    j = parse_gateway_payload('{"pv": {"PV_Voltage": "36.2", "PV Current": 10}, "battery": {"SOC": 81, "Vbat": 26.3}, "LoadPower": 300}')
    assert j == {"pv_volts": 36.2, "pv_amps": 10.0, "bat_volts": 26.3, "bat_soc": 81.0, "load_watts": 300.0, "pv_watts": 362.0}
    h = parse_gateway_payload("<tr><td>PV Power</td><td>512 W</td></tr><tr><td>SOC</td><td>64 %</td></tr>")
    assert h["pv_watts"] == 512 and h["bat_soc"] == 64
