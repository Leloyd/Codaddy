-- SolarBridge AI — MySQL 8 schema
-- Usage:  mysql -u <user> -p < schema.sql
-- The app also runs the CREATE TABLE statements itself on startup (idempotent),
-- and backfills 48h of synthetic telemetry if telemetry_logs is empty.

CREATE DATABASE IF NOT EXISTS solarbridge CHARACTER SET utf8mb4;
USE solarbridge;

CREATE TABLE IF NOT EXISTS system_config (
  id                   INT PRIMARY KEY,
  site_name            VARCHAR(120) NOT NULL DEFAULT 'My Solar Site',
  gateway_ip           VARCHAR(64)  NOT NULL DEFAULT '192.168.4.1',
  gateway_path         VARCHAR(120) NOT NULL DEFAULT '/status',
  poll_interval_sec    INT          NOT NULL DEFAULT 5,
  panel_rated_watts    DOUBLE       NOT NULL DEFAULT 1000,
  panel_tilt           DOUBLE       NOT NULL DEFAULT 15,
  panel_azimuth        DOUBLE       NOT NULL DEFAULT 0,
  battery_capacity_wh  DOUBLE       NOT NULL DEFAULT 2560,
  battery_nominal_v    DOUBLE       NOT NULL DEFAULT 25.6,
  dod_floor_pct        DOUBLE       NOT NULL DEFAULT 20,
  electricity_rate_kwh DOUBLE       NOT NULL DEFAULT 12.50,
  currency_symbol      VARCHAR(8)   NOT NULL DEFAULT '₱',
  grid_emission_kg_kwh DOUBLE       NOT NULL DEFAULT 0.709,
  latitude             DOUBLE       NOT NULL DEFAULT 14.5995,
  longitude            DOUBLE       NOT NULL DEFAULT 120.9842,
  data_mode            VARCHAR(16)  NOT NULL DEFAULT 'simulated',
  sim_scenario         VARCHAR(32)  NOT NULL DEFAULT 'optimal'
);

CREATE TABLE IF NOT EXISTS telemetry_logs (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  timestamp         DATETIME NOT NULL,
  pv_watts          DOUBLE,
  pv_volts          DOUBLE,
  pv_amps           DOUBLE,
  bat_soc           DOUBLE,
  bat_volts         DOUBLE,
  load_watts        DOUBLE,
  irradiance_wm2    DOUBLE,
  ambient_temp_c    DOUBLE,
  expected_pv_watts DOUBLE,
  efficiency_pct    DOUBLE,
  source            VARCHAR(16),
  weather_source    VARCHAR(16),
  INDEX idx_telemetry_ts (timestamp)
);

CREATE TABLE IF NOT EXISTS diagnostic_alerts (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_at  DATETIME NOT NULL,
  severity    ENUM('INFO','WARNING','CRITICAL') NOT NULL,
  category    ENUM('SOILING','SHADING','FAULT','LOW_BATTERY','SYSTEM') NOT NULL,
  message     VARCHAR(500) NOT NULL,
  is_resolved TINYINT(1) NOT NULL DEFAULT 0
);

-- SEED (only used when this file is run by hand; the app seeds via db.seed_history)
INSERT IGNORE INTO system_config (id, site_name) VALUES (1, 'Barangay Health Center — Rooftop PV');

-- 24h of dummy 5-minute telemetry: sine-shaped sun 06:00–18:00, ~12% soiling deficit.
INSERT INTO telemetry_logs
  (timestamp, pv_watts, pv_volts, pv_amps, bat_soc, bat_volts, load_watts,
   irradiance_wm2, ambient_temp_c, expected_pv_watts, efficiency_pct, source, weather_source)
WITH RECURSIVE ticks AS (
  SELECT 0 AS n UNION ALL SELECT n + 1 FROM ticks WHERE n < 287
), base AS (
  SELECT DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:00'), INTERVAL (287 - n) * 5 MINUTE) AS ts FROM ticks
), sun AS (
  SELECT ts,
         GREATEST(0, 950 * SIN(PI() * (HOUR(ts) + MINUTE(ts) / 60 - 6) / 12)) AS g,
         29 + 5 * GREATEST(0, SIN(PI() * (HOUR(ts) + MINUTE(ts) / 60 - 6) / 12)) AS t
  FROM base
)
SELECT ts,
       ROUND(1000 * g / 1000 * 0.88 * 0.88, 1),
       IF(g > 5, 36.5, 0),
       IF(g > 5, ROUND(1000 * g / 1000 * 0.88 * 0.88 / 36.5, 2), 0),
       ROUND(55 + 35 * GREATEST(0, SIN(PI() * (HOUR(ts) + MINUTE(ts) / 60 - 8) / 12)), 1),
       ROUND(25.6 + 0.02 * (55 + 35 * GREATEST(0, SIN(PI() * (HOUR(ts) + MINUTE(ts) / 60 - 8) / 12)) - 50), 2),
       IF(HOUR(ts) BETWEEN 18 AND 22, 420, 180),
       ROUND(g, 1), ROUND(t, 1),
       ROUND(1000 * g / 1000 * 0.88, 1),
       IF(g > 50, 88, NULL),
       'seed', 'model'
FROM sun;

INSERT INTO diagnostic_alerts (created_at, severity, category, message) VALUES
  (NOW() - INTERVAL 20 HOUR, 'WARNING', 'SOILING',
   'Steady 12% output deficit on clear-sky readings. Estimated 0.6 kWh lost/day. Recommend cleaning panels.');
