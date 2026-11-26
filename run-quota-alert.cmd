@echo off
REM ─────────────────────────────────────────────────────────────
REM quota-alert — wrapper สำหรับ Windows Task Scheduler
REM ตั้งเวลารันทุกชั่วโมง แล้วเรียกไฟล์นี้
REM (สคริปต์โหลด .env ในโฟลเดอร์นี้ให้เอง ไม่ต้อง set อะไร)
REM ─────────────────────────────────────────────────────────────

cd /d "%~dp0"

REM ถ้า node ไม่ได้อยู่ใน PATH ให้ใส่ path เต็ม เช่น
REM set NODE="C:\Program Files\nodejs\node.exe"
set NODE=node

%NODE% quota-alert-line.js >> quota-alert.log 2>&1

REM เก็บ log ไม่ให้โตเกิน ~5 MB (เก็บ 1 ไฟล์สำรอง)
for %%A in (quota-alert.log) do if %%~zA GTR 5242880 (
  if exist quota-alert.old.log del quota-alert.old.log
  move /y quota-alert.log quota-alert.old.log >nul
)

exit /b %ERRORLEVEL%
