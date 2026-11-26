#!/bin/sh
# loop เอง: รัน -> นอนจนถึงต้นชั่วโมงถัดไป (ไม่ต้องพึ่ง cron ใน container)
set -u
while true; do
  node /app/quota-alert-line.js >> /app/data/quota-alert.log 2>&1 || true
  now=$(date +%s)
  wait_s=$(( 3600 - now % 3600 ))
  [ "$wait_s" -lt 60 ] && wait_s=$(( wait_s + 3600 ))
  echo "$(date -Iseconds) รอ ${wait_s}s จนถึงรอบถัดไป" >> /app/data/quota-alert.log
  sleep "$wait_s"
done
