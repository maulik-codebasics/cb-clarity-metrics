-- v_daily_kpis: one row per snapshot_date from the site-wide `overall` pull,
-- one column per seeded KPI key. The metric/field mapping is read live from
-- kpi_definitions, so mapping edits in Settings flow through without a migration.
-- Adding a NEW KPI key needs a new migration to add its column.
CREATE VIEW "v_daily_kpis" AS
SELECT
    mv."snapshot_date",
    MAX(mv."value") FILTER (WHERE kd."key" = 'rage_clicks_pct')   AS "rage_clicks_pct",
    MAX(mv."value") FILTER (WHERE kd."key" = 'dead_clicks_pct')   AS "dead_clicks_pct",
    MAX(mv."value") FILTER (WHERE kd."key" = 'quick_backs_pct')   AS "quick_backs_pct",
    MAX(mv."value") FILTER (WHERE kd."key" = 'js_errors_pct')     AS "js_errors_pct",
    MAX(mv."value") FILTER (WHERE kd."key" = 'total_sessions')    AS "total_sessions",
    MAX(mv."value") FILTER (WHERE kd."key" = 'pages_per_session') AS "pages_per_session",
    MAX(mv."value") FILTER (WHERE kd."key" = 'scroll_depth')      AS "scroll_depth",
    MAX(mv."value") FILTER (WHERE kd."key" = 'session_duration')  AS "session_duration"
FROM "metric_values" mv
JOIN "kpi_definitions" kd
    ON kd."metric_name" = mv."metric_name"
   AND kd."field" = mv."field"
WHERE mv."pull_key" = 'overall'
  AND mv."dim1_value" = ''
  AND mv."dim2_value" = ''
  AND mv."dim3_value" = ''
GROUP BY mv."snapshot_date";
