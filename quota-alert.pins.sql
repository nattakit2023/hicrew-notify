-- Report: quota_alert.pins
--
-- หน้าที่: ดึง PIN ที่ยังใช้งานได้ทั้งหมด + quota ปัจจุบัน (ดิบ ๆ ยังไม่กรอง %)
--         ให้ cron ฝั่ง Node เป็นคนคิดเกณฑ์ 70% / 100% เอง
--
-- ทำไมกรองแค่ expired:
--   * PIN ที่หมดอายุแล้วไม่ต้องแจ้งเตือน -> ตัดทิ้งด้วย valid_until
--   * ห้ามกรอง "ใช้หมดแล้ว" (used >= quota) ออก เพราะนั่นคือกลุ่มที่ต้องแจ้ง 100%
--
-- MAC credential: ไม่ต้อง UNION — การใช้งานของ MAC ถูกนับเป็นของ PIN เจ้าของอยู่แล้ว
--
-- Timezone: quota_nodes.valid_until เป็น timestamp naive (UTC)
--           จึงเทียบกับ now() AT TIME ZONE 'UTC'
--
-- LEFT JOIN subscribers (ไม่ใช่ INNER) โดยตั้งใจ: ถ้ามี PIN ที่ยังไม่มีแถว
-- subscriber INNER JOIN จะทำให้ PIN นั้นหายจากผลลัพธ์เงียบ ๆ = พลาดการแจ้งเตือน
--
-- หมายเหตุการใช้งานผ่าน report engine:
--   * :_limit / :_offset ถูก engine ใส่ให้ (injected) — ห้ามส่งมาจาก client
--   * _total จำเป็นสำหรับ pagination (engine ตัดคอลัมน์นี้ออกก่อนส่งคำตอบ)
--   * ต้องมี is_primary = true ไม่งั้น PIN ที่มีหลาย bucket จะได้หลายแถวซ้ำ

SELECT pc.code                                            AS pin_code,
       pc.status                                          AS pin_status,
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
LIMIT :_limit OFFSET :_offset
