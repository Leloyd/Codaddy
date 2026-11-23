# SolarBridge AI

A local-first solar and battery diagnostic hub. It reads your inverter's Wi-Fi dongle on the local network, adds live irradiance from Open-Meteo, saves everything to a local database, and tells you **why** power is low.

## Quick start

```bash
python3 -m venv venv && venv/bin/pip install -r requirements.txt
venv/bin/python app.py          # http://localhost:5000
```

On first boot it creates `solarbridge.db` (SQLite), seeds 48 h of history, and starts the poller inside the app. The app opens in **Simulated Fault Replay** mode, so the demo works without any hardware.

### Using MySQL instead of SQLite

```bash
mysql -u <admin> -p < schema.sql        # creates DB, tables, 24h seed
export MYSQL_USER=solar MYSQL_PASSWORD=... MYSQL_DATABASE=solarbridge  # MYSQL_HOST/PORT optional
venv/bin/python app.py
```

### Running the poller separately

```bash
EMBEDDED_POLLER=0 venv/bin/python app.py   # web only
venv/bin/python poller.py                  # worker only
```

## Dashboard

- `/`: the command center: KPI strip, live power-flow diagram, expected vs actual yield chart, "Why is power low?" diagnosis with one-click fixes, brownout runtime advisor and SDG 7 scorecard. It has light and dark themes (toggle in the top bar, or `?theme=dark` for a kiosk screen).
- `/?mock=1`: forces the built-in browser mock stream. The page also falls back to it automatically if the backend can't be reached.
- `/classic`: the original simple dashboard.

Switching Fault Replay scenarios takes effect immediately: the backend takes a fresh reading and only diagnoses readings taken since the switch. Clicking a one-click fix in demo mode resolves that category's alerts and returns the array to Healthy.

All front-end assets (Tailwind, Chart.js, Lucide, Inter, JetBrains Mono) are copied into `static/`, so the dashboard loads without internet. Tailwind runs from its in-browser build; for production, compile it with the Tailwind CLI instead.

## Connecting real hardware

1. Join the dongle's hotspot with a second USB Wi-Fi adapter (or bridge it onto your LAN).
2. Open ⚙ Settings and enter the gateway IP (`192.168.4.1`), the endpoint path (e.g. `/status`), the array size and battery size.
3. Switch the toggle to **Live Hardware**.

The parser accepts JSON (nested is fine) or plain label/value HTML, and recognizes common key names such as `pv_voltage`, `vpv`, `PV Current`, `SOC` and `LoadPower`. Add your dongle's names to `ALIASES` in `poller.py` if needed. Every live reading is also written to `recordings/live-YYYYMMDD.jsonl`.

**Offline behaviour:** if the hotspot drops, nothing is written and the badge shows **Edge Syncing** while the dashboard serves cached rows. If the internet drops, weather falls back to the last cached Open-Meteo value, then to a clear-sky model. Chart.js is bundled locally, so the dashboard loads with no CDN.

## Demo fail-safe scenarios

| Scenario | What judges see |
|---|---|
| optimal | Green, about 97% performance ratio |
| soiling | Yellow, steady 18% deficit, estimated kWh lost |
| shading | Orange, current drops about 50% every other minute while voltage holds |
| fault | Red, open string (Voc, ~0 A) under full sun |
| brownout | Night outage with a 460 W load: runtime countdown and what-if sliders |
| recorded | Replays your newest `recordings/live-*.jsonl`, or the bundled optimal → shading → fault stream |

## Files

- `app.py`: Flask routes. REST API: `/api/live` (alias `/api/telemetry`), `/api/history`, `/api/impact`, `/api/alerts`, `/api/config`, `/api/runtime?shed=150`. Audit report: `/report` (print to PDF or `?download=1`)
- `poller.py`: gateway scraper, Open-Meteo enrichment, rule runner and alert de-duplication
- `diagnostics.py`: expected yield, the classifier, runtime, energy and impact math (pure functions)
- `simulator.py`: synthetic scenarios and recording replay
- `db.py` / `schema.sql`: MySQL or SQLite storage
- `templates/`, `static/`: dashboard and report

Tests: `venv/bin/python -m pytest -q`
