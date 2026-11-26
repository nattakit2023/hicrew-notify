#!/bin/sh
# loop เอง: รัน -> นอนจนถึงต้นชั่วโมงถัดไป (ไม่ต้องพึ่ง cron ใน container)
# เขียน heartbeat ไว้ให้ HEALTHCHECK ตรวจว่า "ยังทำงานอยู่จริงและรอบล่าสุดไม่พัง"
set -u

HEARTBEAT=/app/data/heartbeat
LOG=/app/data/quota-alert.log

while true; do
  node /app/quota-alert-line.js >> "$LOG" 2>&1
  code=$?

  # heartbeat: "<epoch> <exit code>"  (healthcheck ใช้ 2 ค่านี้)
  printf '%s %s\n' "$(date +%s)" "$code" > "$HEARTBEAT"

  # หมุน log กันโตเกิน ~5 MB
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5242880 ]; then
    mv -f "$LOG" "$LOG.1"
  fi

  now=$(date +%s)
  wait_s=$(( 3600 - now % 3600 ))
  [ "$wait_s" -lt 60 ] && wait_s=$(( wait_s + 3600 ))
  echo "$(date -Iseconds) exit=$code รอ ${wait_s}s จนถึงรอบถัดไป" >> "$LOG"
  sleep "$wait_s"
done
