# quota-alert — รัน 24/7 ทุก 1 ชั่วโมง (ลูปเองในคอนเทนเนอร์ ไม่ต้องใช้ cron ของ host)
FROM node:20-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Bangkok
WORKDIR /app

# ติดตั้ง dependency (pg ใช้เฉพาะ --register-report / AUTH=db)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# โค้ด (ไม่เอา .env / token-store / state / log — ถูกกันด้วย .dockerignore)
COPY quota-alert-line.js quota-alert.pins.sql register-report.sql ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /app/data

VOLUME ["/app/data"]

# healthcheck: heartbeat (/app/data/heartbeat = "<epoch> <exit code>")
#   - ต้องมีรอบล่าสุดภายใน 90 นาที
#   - และรอบล่าสุดต้อง exit 0
HEALTHCHECK --interval=5m --timeout=10s --start-period=15m --retries=3 \
  CMD sh -c 'read ts code < /app/data/heartbeat && now=$(date +%s) && [ $((now-ts)) -lt 5400 ] && [ "$code" = "0" ]'

CMD ["/entrypoint.sh"]
