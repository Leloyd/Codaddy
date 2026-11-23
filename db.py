"""Tiny storage layer: MySQL when configured, SQLite fallback so the demo always boots.

Set MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE to use MySQL.
Without MYSQL_USER, data is written to solarbridge.db (SQLite) next to this file.
All SQL in the app is written with %s placeholders; they are translated for SQLite.
"""
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SQLITE_PATH = os.environ.get("SQLITE_PATH", os.path.join(BASE_DIR, "solarbridge.db"))
BACKEND = "mysql" if os.environ.get("MYSQL_USER") else "sqlite"

_lock = threading.Lock()  # SQLite writes from poller thread + Flask threads


def _connect():
    if BACKEND == "mysql":
        import pymysql

        return pymysql.connect(
            host=os.environ.get("MYSQL_HOST", "127.0.0.1"),
            port=int(os.environ.get("MYSQL_PORT", "3306")),
            user=os.environ["MYSQL_USER"],
            password=os.environ.get("MYSQL_PASSWORD", ""),
            database=os.environ.get("MYSQL_DATABASE", "solarbridge"),
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
        )
    conn = sqlite3.connect(SQLITE_PATH, timeout=10, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _sql(q):
    return q if BACKEND == "mysql" else q.replace("%s", "?")


@contextmanager
def cursor():
    conn = _connect()
    try:
        with _lock if BACKEND == "sqlite" else _nullctx():
            cur = conn.cursor()
            yield cur
            conn.commit()
    finally:
        conn.close()


@contextmanager
def _nullctx():
    yield


def _row(r):
    if r is None:
        return None
    d = dict(r)
    for k, v in d.items():
        if isinstance(v, str) and k in ("timestamp", "created_at"):
            try:
                d[k] = datetime.fromisoformat(v)
            except ValueError:
                pass
    return d


def query(q, args=()):
    with cursor() as cur:
        cur.execute(_sql(q), args)
        return [_row(r) for r in cur.fetchall()]


def query_one(q, args=()):
    rows = query(q, args)
    return rows[0] if rows else None


def execute(q, args=()):
    with cursor() as cur:
        cur.execute(_sql(q), args)
        return cur.lastrowid


def executemany(q, seq):
    with cursor() as cur:
        cur.executemany(_sql(q), seq)


# ---------------------------------------------------------------- schema ----

SQLITE_DDL = """
CREATE TABLE IF NOT EXISTS system_config (
  id INTEGER PRIMARY KEY,
  site_name TEXT NOT NULL DEFAULT 'My Solar Site',
  gateway_ip TEXT NOT NULL DEFAULT '192.168.4.1',
  gateway_path TEXT NOT NULL DEFAULT '/status',
  poll_interval_sec INTEGER NOT NULL DEFAULT 5,
  panel_rated_watts REAL NOT NULL DEFAULT 1000,
  panel_tilt REAL NOT NULL DEFAULT 15,
  panel_azimuth REAL NOT NULL DEFAULT 0,
  battery_capacity_wh REAL NOT NULL DEFAULT 2560,
  battery_nominal_v REAL NOT NULL DEFAULT 25.6,
  dod_floor_pct REAL NOT NULL DEFAULT 20,
  electricity_rate_kwh REAL NOT NULL DEFAULT 12.50,
  currency_symbol TEXT NOT NULL DEFAULT '₱',
  grid_emission_kg_kwh REAL NOT NULL DEFAULT 0.709,
  latitude REAL NOT NULL DEFAULT 14.5995,
  longitude REAL NOT NULL DEFAULT 120.9842,
  data_mode TEXT NOT NULL DEFAULT 'simulated',
  sim_scenario TEXT NOT NULL DEFAULT 'optimal'
);
CREATE TABLE IF NOT EXISTS telemetry_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TIMESTAMP NOT NULL,
  pv_watts REAL, pv_volts REAL, pv_amps REAL,
  bat_soc REAL, bat_volts REAL, load_watts REAL,
  irradiance_wm2 REAL, ambient_temp_c REAL,
  expected_pv_watts REAL, efficiency_pct REAL,
  source TEXT, weather_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_logs(timestamp);
CREATE TABLE IF NOT EXISTS diagnostic_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TIMESTAMP NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  is_resolved INTEGER NOT NULL DEFAULT 0
);
"""


def init_db(seed=True):
    if BACKEND == "sqlite":
        conn = _connect()
        conn.executescript(SQLITE_DDL)
        conn.commit()
        conn.close()
    else:
        with open(os.path.join(BASE_DIR, "schema.sql"), encoding="utf-8") as f:
            ddl = f.read().split("-- SEED")[0]
        with cursor() as cur:
            for stmt in [s.strip() for s in ddl.split(";") if s.strip()]:
                if not stmt.upper().startswith(("CREATE DATABASE", "USE ")):
                    cur.execute(stmt)

    if not query_one("SELECT id FROM system_config WHERE id = 1"):
        execute("INSERT INTO system_config (id) VALUES (1)")
    if seed and not query_one("SELECT id FROM telemetry_logs LIMIT 1"):
        seed_history()


def get_config():
    return query_one("SELECT * FROM system_config WHERE id = 1")


CONFIG_FIELDS = {
    "site_name": str, "gateway_ip": str, "gateway_path": str, "poll_interval_sec": int,
    "panel_rated_watts": float, "panel_tilt": float, "panel_azimuth": float,
    "battery_capacity_wh": float, "battery_nominal_v": float, "dod_floor_pct": float,
    "electricity_rate_kwh": float, "currency_symbol": str, "grid_emission_kg_kwh": float,
    "latitude": float, "longitude": float, "data_mode": str, "sim_scenario": str,
}


def update_config(values):
    clean = {}
    for k, v in values.items():
        if k in CONFIG_FIELDS and v not in (None, ""):
            clean[k] = CONFIG_FIELDS[k](v)
    if clean:
        sets = ", ".join(f"{k} = %s" for k in clean)
        execute(f"UPDATE system_config SET {sets} WHERE id = 1", tuple(clean.values()))
    return get_config()


def insert_telemetry(r):
    cols = ["timestamp", "pv_watts", "pv_volts", "pv_amps", "bat_soc", "bat_volts",
            "load_watts", "irradiance_wm2", "ambient_temp_c", "expected_pv_watts",
            "efficiency_pct", "source", "weather_source"]
    execute(
        f"INSERT INTO telemetry_logs ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
        tuple(r.get(c) for c in cols),
    )


def seed_history(hours=48):
    """Backfill synthetic history so charts, impact and report are populated on first boot."""
    import simulator
    import diagnostics

    cfg = get_config()
    now = datetime.now().replace(second=0, microsecond=0)
    start = now - timedelta(hours=hours)
    sim = simulator.Simulator(cfg, scenario="soiling_mild", realtime_sun=True, soc=70)
    rows = []
    t = start
    while t < now:
        r = sim.step(t, dt_sec=300)
        r["expected_pv_watts"] = diagnostics.expected_pv_watts(
            r["irradiance_wm2"], r["ambient_temp_c"], cfg["panel_rated_watts"])
        r["efficiency_pct"] = diagnostics.efficiency_pct(r["pv_watts"], r["expected_pv_watts"])
        r["source"], r["weather_source"] = "seed", "model"
        rows.append(r)
        t += timedelta(minutes=5)
    cols = ["timestamp", "pv_watts", "pv_volts", "pv_amps", "bat_soc", "bat_volts", "load_watts",
            "irradiance_wm2", "ambient_temp_c", "expected_pv_watts", "efficiency_pct",
            "source", "weather_source"]
    executemany(
        f"INSERT INTO telemetry_logs ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
        [tuple(r[c] for c in cols) for r in rows],
    )
    execute(
        "INSERT INTO diagnostic_alerts (created_at, severity, category, message, is_resolved) "
        "VALUES (%s, %s, %s, %s, %s)",
        (now - timedelta(hours=20), "WARNING", "SOILING",
         "Steady 12% output deficit on clear-sky readings. Estimated 0.6 kWh lost/day. "
         "Recommend cleaning panels.", 0),
    )
