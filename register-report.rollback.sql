-- ถอนรายงานออกจาก registry (ใช้เมื่อต้องการยกเลิก/เริ่มใหม่)
--   psql "$PROD_DATABASE_URL" -f register-report.rollback.sql
-- ปลอดภัย: ลบเฉพาะแถวชื่อ quota_alert.pins
DELETE FROM report_query WHERE name = 'quota_alert.pins';
