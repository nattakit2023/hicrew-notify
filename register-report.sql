-- ลงทะเบียนรายงาน quota_alert.pins เข้า report engine
-- ไม่ต้อง deploy backend — report registry อยู่ในตาราง report_query
--
-- รันครั้งเดียว:  psql "$DATABASE_URL" -f register-report.sql
-- แก้ SQL ภายหลัง: แก้ใน report_query ได้ตรง ๆ แล้วค่อย
--                  cargo run -p infra-db --bin report-catalog -- dump --write-migration
--                  เพื่อเก็บกลับเข้า git (traceability)
--
-- ตรวจผล:  GET  /admin/reports/catalog
-- ทดสอบ:   POST /admin/reports/quota_alert.pins/run   { "params": {}, "page": 1, "page_size": 500 }

INSERT INTO report_query (name,
                          description,
                          sql_template,
                          totals_sql_template,
                          param_spec,
                          required_permission,
                          max_range_days,
                          version,
                          is_active)
VALUES (
           'quota_alert.pins',
           'PIN ที่ยังใช้งานได้ (ไม่รวม revoked/หมดอายุ) พร้อมโควตาปัจจุบัน: quota_bytes, used_bytes, remaining_bytes, used_pct และวันหมดอายุ ใช้สำหรับแจ้งเตือนทาง LINE เมื่อใช้เกินเกณฑ์ 70%/100% (การใช้งานของ MAC นับรวมเป็นของ PIN เจ้าของแล้ว)',
           $sql$SELECT pc.code                                            AS pin_code,
       pc.status                                          AS pin_status,
       pc.remark                                          AS remark,
       s.vessel_id,
       v.vessel_name,
       qn.quota_bytes,
       qn.used_bytes,
       GREATEST(qn.quota_bytes - qn.used_bytes, 0)::bigint AS remaining_bytes,
       CASE
           WHEN qn.quota_bytes > 0
           THEN round(100.0 * qn.used_bytes / qn.quota_bytes, 2)
       END                                                AS used_pct,
       qn.valid_until,
       count(*) OVER ()                                   AS _total
FROM pin_codes pc
         JOIN quota_nodes qn
              ON qn.owner_id = COALESCE(pc.subscriber_id, pc.id)
                  AND qn.is_primary = true
         LEFT JOIN subscribers s
              ON s.owner_id = COALESCE(pc.subscriber_id, pc.id)
         LEFT JOIN vessels v ON v.id = s.vessel_id
WHERE pc.status <> 'revoked'
  AND (qn.valid_until IS NULL
    OR qn.valid_until > (now() AT TIME ZONE 'UTC'))
ORDER BY used_pct DESC NULLS LAST, pc.code
LIMIT :_limit OFFSET :_offset$sql$,
           NULL,
           '[{"name":"_limit","type":"integer","required":false,"injected":true},
             {"name":"_offset","type":"integer","required":false,"injected":true}]'::jsonb,
           'reports:read',
           NULL,   -- max_range_days = NULL: รายงานแบบ snapshot ไม่ต้องส่งช่วงวันที่
           1,
           TRUE
       )
ON CONFLICT (name) DO UPDATE
    SET description    = EXCLUDED.description,
        sql_template   = EXCLUDED.sql_template,
        param_spec     = EXCLUDED.param_spec,
        version        = report_query.version + 1,
        is_active      = TRUE,
        updated_at     = NOW();
