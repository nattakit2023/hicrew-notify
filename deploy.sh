#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# deploy.sh — deploy/อัปเดต hicrew-notify บน server (แผน B: build บนเครื่อง)
#
#   ./deploy.sh                 # ใช้ .env.prod และ branch dev
#   ENV_FILE=.env BRANCH=develop ./deploy.sh
#   ./deploy.sh --no-pull       # ไม่ดึงโค้ด (build จากของเดิม)
#   ./deploy.sh --check-only    # ตรวจอย่างเดียว ไม่ build/ไม่ restart
#
# สิ่งที่ทำ: ตรวจ env -> git pull -> build -> up -d -> รอ -> --check -> log
# ─────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env.prod}"
BRANCH="${BRANCH:-dev}"
SERVICE="quota-alert"
CONTAINER="hicrew-notify"

DO_PULL=1
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-pull)    DO_PULL=0 ;;
    --check-only) CHECK_ONLY=1 ;;
    -h|--help)    sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $arg"; exit 2 ;;
  esac
done

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0) ตรวจเครื่องมือ + ไฟล์ config ─────────────────────────
COMPOSE="docker compose"
if ! docker compose version >/dev/null 2>&1; then
  command -v docker-compose >/dev/null 2>&1 || die "ไม่พบ docker compose"
  COMPOSE="docker-compose"
fi
ok "$($COMPOSE version --short 2>/dev/null || echo 'docker compose')"

[ -f "$ENV_FILE" ] || die "ไม่พบ $ENV_FILE — คัดลอกจาก .env.prod.example ก่อน (cp .env.prod.example $ENV_FILE)"
chmod 600 "$ENV_FILE" 2>/dev/null || true

need() { grep -qE "^$1=.+" "$ENV_FILE" || die "$1 ยังว่างใน $ENV_FILE"; }
need API_BASE_URL
need LINE_CHANNEL_TOKEN
need LINE_GROUP_ID
ok "config ครบ ($ENV_FILE)"

mkdir -p data

# ── 1) ดึงโค้ด ───────────────────────────────────────────────
if [ "$DO_PULL" = "1" ] && [ "$CHECK_ONLY" = "0" ]; then
  step "1/6 ดึงโค้ดล่าสุด (branch $BRANCH)"
  git fetch --all --prune
  git rev-parse --verify "$BRANCH" >/dev/null 2>&1 || die "ไม่พบ branch $BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only
  ok "ตอนนี้อยู่ที่ $(git log --oneline -1)"
fi

# ── 2) ตรวจก่อน build (เร็ว ๆ) ──────────────────────────────
if [ "$CHECK_ONLY" = "0" ]; then
  step "2/6 ตรวจ logic ในเครื่อง (ไม่ใช้ credential)"
  node --check quota-alert-line.js 2>/dev/null || docker run --rm -v "$PWD":/w -w /w node:20-alpine node --check quota-alert-line.js
  node quota-alert-line.js --selftest 2>/dev/null || \
    docker run --rm -v "$PWD":/w -w /w node:20-alpine node quota-alert-line.js --selftest
fi

# ── 3) build + up ───────────────────────────────────────────
if [ "$CHECK_ONLY" = "0" ]; then
  step "3/6 build image"
  $COMPOSE --env-file "$ENV_FILE" build

  step "4/6 start container"
  $COMPOSE --env-file "$ENV_FILE" up -d
  sleep 5
fi

# ── 4) สถานะ container ──────────────────────────────────────
step "5/6 สถานะ"
if docker ps --filter "name=$CONTAINER" --format '{{.Names}}' | grep -q "$CONTAINER"; then
  docker ps --filter "name=$CONTAINER" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
  ok "container ทำงานอยู่"
else
  $COMPOSE --env-file "$ENV_FILE" logs --tail 30 "$SERVICE" || true
  die "container ไม่ได้ทำงาน — ดู log ด้านบน"
fi

# ── 5) ตรวจ end-to-end (--check) ────────────────────────────
step "6/6 ตรวจ config + token + ข้อมูลจริง (--check)"
if ! $COMPOSE --env-file "$ENV_FILE" run --rm --entrypoint node "$SERVICE" \
      /app/quota-alert-line.js --check; then
  die "--check ไม่ผ่าน — ดูข้อความ ❌ ด้านบน"
fi

# ── 6) log ล่าสุด ───────────────────────────────────────────
step "log ล่าสุด"
$COMPOSE --env-file "$ENV_FILE" logs --tail 15 "$SERVICE" || true

printf '\n\033[32m✅ deploy เสร็จ\033[0m\n'
printf '   healthcheck : docker inspect --format "{{.State.Health.Status}}" %s\n' "$CONTAINER"
printf '   heartbeat   : cat data/heartbeat   ("<epoch> <exit code>")\n'
printf '   ต่อจากนี้สคริปต์จะทำงานเองทุกชั่วโมง (ลูปในคอนเทนเนอร์)\n'
