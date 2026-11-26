-- ตรวจว่าลงทะเบียนรายงานสำเร็จ (รันบน DB เดียวกับที่ API ใช้)
--   psql "$PROD_DATABASE_URL" -f register-report.verify.sql
SELECT name,
       version,
       is_active,
       required_permission,
       max_range_days,
       jsonb_array_length(param_spec)                    AS param_count,
       (sql_template LIKE '%pc.remark%')                 AS has_remark,
       (sql_template LIKE '%is_primary%')                AS has_is_primary,
       updated_at
FROM report_query
WHERE name = 'quota_alert.pins';
