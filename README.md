# quota-alert — แจ้งเตือนโควตาข้อมูล PIN ทาง LINE (รายชั่วโมง)

> โฟลเดอร์นี้ **แยกจากทุก repo** (`~/workspace/quota-alert`) — ไม่ผูกกับ api / backoffice / mkt-app
> เป็นงาน ops ที่ใช้ report engine ของ backend ผ่าน API เท่านั้น (ไม่มีโค้ดฝั่ง backend อยู่ในนี้)

แจ้งเข้ากลุ่ม LINE เมื่อ PIN ใดข้ามเกณฑ์ **70% (ใกล้หมด)** หรือ **100% (หมดแล้ว)**
โดย **1 PIN ได้ 1 ครั้งต่อระดับ** — ไม่ส่งซ้ำทุกชั่วโมง

```
cron (ทุกชั่วโมง)
  └─ quota-alert-line.js
       ├─ POST /admin/reports/quota_alert.pins/run   ← report engine (SQL อยู่ใน DB)
       ├─ คิดระดับ ok → near(≥70%) → full(≥100%)
       ├─ เทียบ state เดิม → เลือกเฉพาะที่ "ระดับสูงขึ้น"
       └─ POST api.line.me/v2/bot/message/push       ← 1 ข้อความ/รอบ
```

## ไฟล์ในชุดนี้

| ไฟล์ | หน้าที่ |
|---|---|
| `quota-alert.pins.sql` | SQL ต้นฉบับ (อ่าน/comments) |
| `register-report.sql` | ลงทะเบียน report เข้า `report_query` (ไม่ต้อง deploy backend) |
| `quota-alert-line.js` | สคริปต์ cron (+ `--selftest`) |
| `.env.example` | ตัวอย่างค่าตั้ง |
| `README.md` | ไฟล์นี้ |

---

## 1. ลงทะเบียน report (ครั้งเดียว)

```bash
psql "$DATABASE_URL" -f register-report.sql
```

ตรวจว่าขึ้นทะเบียนแล้ว:

```bash
curl -s "$API/admin/reports/catalog" -H "Authorization: Bearer $TOKEN" | jq '.data[] | select(.name=="quota_alert.pins")'
```

ทดสอบเรียกด้วยมือ:

```bash
curl -s -X POST "$API/admin/reports/quota_alert.pins/run" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"params":{},"page":1,"page_size":5}' | jq '.total, .data[0]'
```

> SQL ใน report กรอง **revoked** และ **หมดอายุ (`valid_until`)** ออกให้แล้ว
> แต่ **ไม่กรอง PIN ที่ใช้ครบ 100%** เพราะนั่นคือกลุ่มที่ต้องแจ้ง

## 2. ตั้งค่า

```bash
cp .env.example .env
chmod 600 .env                 # มี token อยู่ข้างใน
vi .env                        # เติม LOGTO_* , LINE_CHANNEL_TOKEN , LINE_GROUP_ID
```

> สคริปต์ **โหลด `.env` ในโฟลเดอร์เดียวกันให้อัตโนมัติ** — ไม่ต้อง `source` เอง
> (ค่าที่ `export` ไว้ในเครื่องจะชนะค่าในไฟล์ ถ้าต้องการทดสอบชั่วคราว)
> ใช้ไฟล์อื่นได้ด้วย `ENV_FILE=/path/to/other.env node quota-alert-line.js ...`

## 3. ทดสอบโดยไม่ส่งจริง

```bash
node quota-alert-line.js --selftest          # ทดสอบตรรกะ (ไม่ต้องมี credential)
DRY_RUN=1 node quota-alert-line.js           # ดึงข้อมูลจริง + พิมพ์ข้อความ ไม่ส่ง LINE
```

> `DRY_RUN=1` **ไม่บันทึก state** → รันซ้ำจะได้ผลเหมือนเดิม ใช้ทดสอบได้ไม่จำกัด

## 4. cron รายชั่วโมง

```bash
crontab -e
```

```cron
# quota alert — ทุกชั่วโมงตรง (.env ถูกโหลดโดยสคริปต์เอง)
0 * * * * cd /home/sandboxuser/workspace/quota-alert && /usr/bin/node quota-alert-line.js >> /var/log/quota-alert.log 2>&1
```

> ถ้าใช้ systemd จริงจัง แนะนำ `systemd timer` (มี journal + restart policy) — ตัวอย่างอยู่ท้ายไฟล์

## 5. ตรวจสุขภาพ

```bash
tail -50 /var/log/quota-alert.log       # ทุกรอบจะพิมพ์จำนวน PIN + จำนวนที่แจ้ง
cat /var/lib/quota-alert/state.json     # ระดับที่จำไว้ต่อ PIN
```

---

## ทดสอบใน Staging (ลำดับที่แนะนำ)

```bash
cd ~/workspace/quota-alert
cp .env.example .env && vi .env     # API_BASE_URL = https://hicrew-staging-api.worshipcats.com
```

| ขั้น | คำสั่ง | ต้องมีอะไร |
|---|---|---|
| 1 | `node quota-alert-line.js --selftest` | ไม่ต้องมีอะไร |
| 2 | `node quota-alert-line.js --test-line` | LINE token + groupId |
| 3 | `AUTH=token ACCESS_TOKEN='<token จากเบราว์เซอร์>' SKIP_LINE_CHECK=1 node quota-alert-line.js --check` | token (จะเจอ 404 ถ้ารายงานยังไม่ลงทะเบียน = ปกติ) |
| 4 | `psql "$STAGING_DATABASE_URL" -f register-report.sql` | DB ของ staging |
| 5 | `node quota-alert-line.js --check` | ต้องขึ้น ✅ ทั้งหมด |
| 6 | `DRY_RUN=1 node quota-alert-line.js` | ดูข้อความจริง (ไม่ส่ง LINE) |
| 7 | `node quota-alert-line.js` | รันจริง 1 ครั้ง → สร้าง state |

> `SKIP_LINE_CHECK=1` ใช้ตอนทดสอบเฉพาะฝั่ง API (LINE ยังไม่พร้อม)
> `DRY_RUN=1` ไม่บันทึก state → รันซ้ำได้ไม่มีผลข้างเคียง

---

## รูปแบบข้อความ (จัดกลุ่มตามเรือ)

```
📊 แจ้งเตือนโควตาข้อมูล — 24 Nov 2026, 14:00

🚢 MANDARIN QUEEN 9 (🔴 1 · 🟠 1)
  🔴 PIN-000123 · ลูกเรือ กะดึก · 10.00/10.00 GB (100.0%)
  🟠 PIN-000789 · 9.62/10.00 GB (96.2%)

🚢 SIRIUS STAR (🔴 1)
  🔴 PIN-000456 · 7.10/5.00 GB (142.0%)

🚢 เรือ #42 (🟠 1)
  🟠 PIN-000999 · 8.40/10.00 GB (84.0%)

รวม 🔴 หมดแล้ว 2 · 🟠 ใกล้หมด 2 รายการ
```

รูปแบบบรรทัด: `<สี> <PIN> · <remark> · <used>/<quota> GB (<pct>)`

### เมื่อมีการเติม/เปลี่ยนโควตา

สคริปต์เก็บ `quota_bytes` ไว้ใน `state.json` ด้วย → **ถ้าโควตาเปลี่ยน = เริ่มรอบใหม่**

| ก่อน | หลังเติม | ผล |
|---|---|---|
| 1.00/1.00 GB (🔴 full) | 1.00/2.00 GB (50%) | แจ้ง `♻️ ปรับโควตา 1.00 → 2.00 GB` (ระดับใหม่ ok → ไม่มีหัวข้อ 🔴/🟠) |
| 1.00/1.00 GB (🔴 full) | 1.00/1.20 GB (83%) | แจ้งทั้ง `🟠` (ระดับใหม่ near) และ `♻️ ปรับโควตา` |
| 1.42/2.00 GB (🟠 near) | 1.42/3.00 GB (47%) | แจ้ง `♻️ ปรับโควตา` แล้วรอบถัดไปแจ้ง 🟠 อีกครั้งเมื่อถึง 70% |
| โควตาเท่าเดิม | — | เงียบ (กันสแปมรายชั่วโมง) |

ปิดส่วน `♻️` ได้ด้วย `NOTIFY_QUOTA_CHANGE=0` (เช่น ช่วงต่ออายุรายเดือนที่เปลี่ยนโควตาทุก PIN)
- สีอย่างเดียวบอกระดับ (🔴 หมดแล้ว / 🟠 ใกล้หมด) — ไม่มีคำกำกับหน้า PIN
- `remark` แสดงหลัง PIN และตัดที่ 40 ตัวอักษร (ถ้าไม่มี remark จะข้ามไป)

กติกาการเรียง:
1. **เรือที่มี 🔴 ขึ้นก่อน** แล้วจึงเรือที่มีแค่ 🟠 (ถ้าเท่ากันเรียงตามชื่อเรือ)
2. ภายในเรือเดียวกัน: 🔴 ก่อน 🟠 แล้วเรียงตามรหัส PIN
3. PIN ที่ไม่มีชื่อเรือ → ไปอยู่กลุ่ม `ไม่ระบุเรือ` (หรือ `เรือ #<vessel_id>` ถ้ามี id)
4. ดูตัวอย่างได้ด้วย `node quota-alert-line.js --preview` (ไม่ต้องมี credential)

---

## ตรรกะการแจ้ง (สำคัญ)

| สถานการณ์ | แจ้งไหม | state |
|---|---|---|
| PIN ยังไม่เคยแจ้ง ใช้ไป 75% | ✅ near | `near` |
| รอบถัดไปยัง 78% | ❌ | `near` |
| ใช้ไปถึง 100% | ✅ full | `full` |
| รอบถัดไปยัง 100% | ❌ | `full` |
| ซื้อแพ็กใหม่ ใช้ลดลงเป็น 20% | ❌ (เงียบ) | `ok` |
| กลับมาถึง 72% อีกครั้ง | ✅ near | `near` |
| PIN หายจากรายการ (ลบ/หมดอายุ) | ❌ | ลบออก |
| `quota_bytes` = 0 / NULL | ❌ | ไม่เก็บ |

---

## ข้อจำกัดของ LINE ที่ต้องรู้

- **LINE Notify ปิดบริการแล้ว** (มี.ค. 2025) → ใช้ **Messaging API** เท่านั้น
- **โควตาข้อความ/เดือนขึ้นกับแพ็กเกจ OA** — ตรวจตัวเลขจริงใน LINE Official Account Manager
  (`push` ทุกครั้งนับ 1 ข้อความ; `reply` ที่ตอบ event ไม่นับ) → สคริปต์นี้จึงส่ง **เฉพาะตอนระดับเปลี่ยน**
- **ขนาดข้อความ**: สูงสุด 5,000 ตัวอักษร/ข้อความ และไม่เกิน 5 ข้อความ/ครั้ง → สคริปต์แบ่งให้อัตโนมัติที่ 4,500 ตัวอักษร
- **groupId**: บอทต้องถูกเชิญเข้ากลุ่มก่อน และต้องใช้ `groupId` (ไม่ใช่ `userId`) — เก็บได้จาก webhook event `join`
- **Channel access token**: มีทั้งแบบมีอายุและแบบ long-lived — ถ้าใช้แบบมีอายุต้องมีขั้นตอน refresh (สคริปต์นี้ยังไม่ทำ; แนะนำ long-lived)

---

## Auth (4 โหมด)

| `AUTH` | ต้องมี | หมายเหตุ |
|---|---|---|
| **`refresh`** | `LOGTO_ENDPOINT` + `LOGTO_CLIENT_ID` (+ `REFRESH_TOKEN` ครั้งแรก) | **โหมดที่ใช้อยู่** — Logto หมุน token อัตโนมัติ |
| `logto` | `LOGTO_ENDPOINT/CLIENT_ID/CLIENT_SECRET` | M2M (client_credentials) — ต้องมีแถวใน `users` ด้วย |
| `token` | `ACCESS_TOKEN` | ทดสอบเร็ว แต่ต้องเปลี่ยนเมื่อหมดอายุ |
| `db` | `DATABASE_URL` (+ `npm i pg`) | ต่อ DB อ่านอย่างเดียว ไม่ผ่าน API |

### AUTH=refresh — วิธีใช้

```env
AUTH=refresh
REFRESH_VIA=api        # ให้ backend แลก token ให้ (ไม่ต้องมี client_secret)
API_BASE_URL=https://hicrew-staging-api.worshipcats.com
```

```bash
# 1) ตั้งครั้งแรก (แลก token ทันทีเพื่อยืนยัน)
node quota-alert-line.js --set-refresh-token '<refresh_token>'

# 2) ตรวจสถานะ (บอกว่า access token เหลืออีกกี่วินาที)
node quota-alert-line.js --check
```

token จะถูกเก็บที่ `token-store.json` (สิทธิ์ **600**) และอัปเดตทุกครั้งที่ refresh

**ตรวจว่ากำลังใช้ token ของใคร**

```bash
node quota-alert-line.js --whoami
# 👤 admin@example.com · role=Admin · id=1
```

`--check` ก็เรียก `/admin/get-me` ให้ด้วย ⇒ เห็นทันทีว่า token ที่ใส่ไว้เป็น user คนไหน

**สิ่งที่ต้องรู้ (สำคัญ)**
- Logto **หมุน refresh token ทุกครั้งที่ใช้** → ตัวเก่าใช้ไม่ได้ทันที
  สคริปต์จึง **บันทึก token ชุดใหม่ก่อน** เรียก API ใด ๆ
- ถ้าเห็น `invalid_grant` = token ถูกใช้ไปแล้ว/หมดอายุ → ขอใหม่แล้วรัน `--set-refresh-token` อีกครั้ง
- ถ้า access token ยังเหลือ **>2 นาที** สคริปต์จะใช้ซ้ำ **ไม่ rotate** (ลดความเสี่ยง token หลุด)
- refresh token ผูกกับ **user** → user นั้นต้องมีแถวในตาราง `users` (มีสิทธิ์ `reports:read`)
- ⚠️ อย่า copy `token-store.json` ไปหลายเครื่องแล้วรันพร้อมกัน — token จะชนกัน (ใช้ได้ทีละที่)

**`invalid_grant` แก้อย่างไร**

```bash
node quota-alert-line.js --token-info     # ดู iss / client_id / exp ของ token
```

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| `invalid_grant` ทันทีที่ตั้ง token | token ถูก rotate ไปแล้ว (ก็อปจากแท็บที่ยังเปิด) | login ใหม่แบบ **incognito** → ก็อป refresh token จาก response `POST /auth/callback` → **ปิดแท็บทันที** → `--set-refresh-token` |
| `iss` ไม่ใช่ `https://logto.worshipcats.com/oidc` | token มาจากคนละ tenant | ขอ token จาก tenant ที่ API นี้ใช้ |
| `client_id` ไม่ใช่ `u99ejkeu8szpbqocwwe7m` | token ออกให้แอปอื่น | ใช้ refresh token ของ Backoffice app ตัวเดียวกัน |
| `exp` ผ่านมาแล้ว | token หมดอายุ | ขอใหม่ |

> ทางลัดสำหรับทดสอบอย่างอื่นก่อน: ใช้ **access token** จาก DevTools
> ```bash
> AUTH=token ACCESS_TOKEN='<access token>' DRY_RUN=1 node quota-alert-line.js --check
> ```
> (access token อายุ ~1 ชม. แต่พอทดสอบ report/ข้อความได้ครบ)

**`REFRESH_VIA` เลือกอะไร**

| ค่า | ใช้เมื่อ | ต้องมี |
|---|---|---|
| **`api`** (ค่าเริ่มต้น) | app ใน Logto เป็น **confidential** (มี client_secret) ซึ่งเราไม่มี | แค่ `API_BASE_URL` — backend แลกให้ |
| `logto` | app เป็น **public client** (ไม่มี secret) หรือเรามี secret | `LOGTO_ENDPOINT` + `LOGTO_CLIENT_ID` (+ secret ถ้ามี) |

อาการที่บ่งบอกว่าต้องใช้ `api`: Logto ตอบ
`invalid_request … requested grant type is not allowed for this client`
(เพราะ request ไม่มี `client_secret` แต่ app ต้องการ)

### ใช้ refresh token ของ user จริง (กรณีที่ใช้อยู่)

ใช้ได้เลย — เพราะ `/admin/*` หาแถวใน `users` จาก `sub` ของ token และสิทธิ์อ่านจาก `user_permissions`
แต่มีข้อควรระวัง:

| เรื่อง | รายละเอียด |
|---|---|
| สิทธิ์เกินจำเป็น | token นี้ = สิทธิ์ **เต็ม** ของ user นั้น (ไม่ใช่แค่ `reports:read`) ถ้าไฟล์หลุด = หลุดทั้งระบบ → ควรสร้าง user เฉพาะภายหลัง |
| แย่ง session กับเบราว์เซอร์ | Logto หมุน refresh token → ถ้าใช้ token ตัวเดียวกับแท็บที่ยังเปิดอยู่ อีกฝั่งจะหลุด วิธีปลอดภัย: เปิด **incognito** login → copy token → ปิดหน้าต่าง แล้วให้ cron ใช้ตัวนั้น |
| อายุ token | ถ้า cron หยุดนานกว่า TTL ของ refresh token → `invalid_grant` ต้องขอใหม่ (รันทุกชั่วโมงจะ rotate/ต่ออายุเอง) |
| logout / เปลี่ยนรหัส | ถ้าไป "ออกจากระบบทุกอุปกรณ์" หรือเปลี่ยนรหัสผ่าน grant อาจถูกยกเลิก → cron หยุด ต้องตั้ง token ใหม่ |
| ที่เก็บ | `.env` + `token-store.json` สิทธิ์ 600, อยู่เครื่องเดียว, **อย่า** เข้า backup/docker image/git |

---

## Deploy ด้วย GitLab (แผน B) — repo + build บน server

### ครั้งแรก: สร้าง repo private

```bash
cd <โฟลเดอร์นี้>
git init -b main
git add -A
git status --short           # ต้องไม่เห็น .env / token-store.json / state.json / node_modules
git commit -m "feat: hourly PIN quota alert to LINE"
git remote add origin https://gitlab.com/pnart-wednesday/notify-line.git
git tag -a v1.0.0 -m "v1.0.0 — initial"
git push -u origin main --tags
```

ตรวจว่าไฟล์ลับถูก ignore จริง:
```bash
git check-ignore -v .env token-store.json state.json node_modules
```

### ครั้งแรก: บน server
```bash
git clone https://gitlab.com/pnart-wednesday/notify-line.git /opt/quota-alert
cd /opt/quota-alert
cp .env.example .env && vi .env         # API_BASE_URL / LOGTO_* / LINE_*
chmod 600 .env
mkdir -p data
docker compose up -d --build

# seed refresh token (ครั้งเดียว — token ผูกกับเครื่องนี้)
docker compose run --rm --entrypoint node quota-alert /app/quota-alert-line.js --set-refresh-token '<refresh_token>'
docker compose run --rm --entrypoint node quota-alert /app/quota-alert-line.js --check
docker compose logs -f --tail 30
```

### 5) ตรวจสุขภาพคอนเทนเนอร์ (healthcheck)

คอนเทนเนอร์เขียน `data/heartbeat` ทุกครั้งที่จบรอบ (`<epoch> <exit code>`)
แล้ว healthcheck จะตอบ **healthy** เมื่อ:

| เงื่อนไข | ความหมาย |
|---|---|
| รอบล่าสุด **ภายใน 90 นาที** | ลูปไม่ตาย/ไม่ค้าง |
| รอบล่าสุด **exit 0** | สคริปต์ไม่ได้ error |

```bash
docker ps --filter name=quota-alert          # ดูคอลัมน์ STATUS (healthy / unhealthy)
docker inspect --format '{{.State.Health.Status}}' quota-alert
docker inspect --format '{{json .State.Health.Log}}' quota-alert | tail -3
cat data/heartbeat                           # <epoch> <exit code>
```

> ⚠️ `healthcheck` แค่ **รายงานสถานะ** ไม่ได้ restart ให้ — ถ้าอยากให้ restart อัตโนมัติเมื่อ unhealthy
> ใช้ container `willfarrell/autoheal` หรือปล่อยให้ cron/systemd ภายนอกเป็นตัวเฝ้า

### 6) อัปเดต / rollback
```bash
git pull && docker compose up -d --build             # อัปเดต
git checkout v1.0.0 && docker compose up -d --build  # ย้อนเวอร์ชัน
```

### ถ้าอยากให้ CI build image (ภายหลัง)
```bash
cp ci/gitlab-ci.build-image.yml.sample .gitlab-ci.yml
# + เปิด Container Registry ของโปรเจกต์ แล้วแก้ docker-compose ให้ใช้ image: $CI_REGISTRY_IMAGE:vX.Y.Z
```

---

## อนาคต: ย้ายเข้าโปรเจกต์หลัก

ชุดนี้ออกแบบให้ **ย้ายได้ทั้งก้อน** (ไม่ผูก path ภายนอก ใช้ `__dirname` ทั้งหมด)

| ของในชุดนี้ | ปลายทางที่แนะนำ |
|---|---|
| `quota-alert.pins.sql` + `register-report.sql` | ย้ายเข้า repo `api` เป็น `migrations/src/sql/reports/` + migration (ใช้ `report-catalog dump --write-migration`) → report มีประวัติใน git |
| `quota-alert-line.js` | ย้ายเป็น job ใน `crates/app-jobs` (มี scheduler/observability อยู่แล้ว) หรือคงไว้เป็น ops tool |
| `state.json` (dedupe) | ย้ายเป็นตาราง DB เช่น `notification_log (pin_code, level, notified_at)` → รันหลายเครื่องพร้อมกันได้ |
| การส่ง LINE | ย้ายเป็น service กลาง (ใช้ร่วมกับแจ้งเตือนอื่น: session, payment ฯลฯ) |
| `README.md` / `quota-alert-flow.pdf` | เก็บเป็นเอกสาร ops |

> ระหว่างนี้ชุดนี้ทำงานแยกได้ 100% — ไม่ต้องรอ backend และไม่บล็อกงานหลัก

---

## ทดสอบกับ Production อย่างปลอดภัย

### 0) เช็คก่อนว่า Prod API มี report engine ไหม
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<prod-api-host>/admin/reports/catalog
```
| ผล | ความหมาย |
|---|---|
| **401** | มี route อยู่ — ไปต่อได้ |
| **404** | Prod API รุ่นเก่า ยังไม่มี report engine → ต้องอัปเดต backend ก่อน |

### 1) เตรียมไฟล์แยกจาก staging
```bash
cp .env.prod.example .env.prod
vi .env.prod        # API_BASE_URL (prod), LOGTO_CLIENT_ID, LINE_GROUP_ID, DRY_RUN=1
chmod 600 .env.prod
```
> `.env.prod` ถูก ignore แล้ว · `STATE_FILE` แยกไฟล์ → dedupe ของ prod ไม่ปนกับ staging

### 2) ลงทะเบียน report ใน Prod DB (ครั้งเดียว)
```bash
psql "$PROD_DATABASE_URL" -f register-report.sql
# หรือ: ENV_FILE=.env.prod DATABASE_URL=... node quota-alert-line.js --register-report
```

### 3) ทดสอบแบบไม่ส่งอะไร
```bash
ENV_FILE=.env.prod node quota-alert-line.js --whoami
ENV_FILE=.env.prod node quota-alert-line.js --check        # DRY_RUN=1 อยู่ใน .env.prod
```

### 4) ดูข้อความที่จะส่งจริง แล้วค่อยเลือก
```bash
ENV_FILE=.env.prod node quota-alert-line.js                # DRY_RUN=1 -> พิมพ์อย่างเดียว
# ถ้าโอเค: เอา DRY_RUN=0 ใน .env.prod หรือ override ชั่วคราว
ENV_FILE=.env.prod DRY_RUN=0 node quota-alert-line.js --test-line
```

### ข้อควรระวังกับ Prod

| เรื่อง | ทำไม |
|---|---|
| ใช้ token ของ user ที่มีสิทธิ์แค่ `reports:read` | ลดความเสียหายถ้า token หลุด |
| **LINE: ใช้กลุ่มทดสอบก่อน** | รอบแรกอาจมี PIN ≥70% หลายสิบรายการ → จะส่งเข้ากลุ่มจริงทันที |
| `DRY_RUN=1` ก่อนเสมอ | ไม่ส่งข้อความ **และไม่เขียน state** → รันซ้ำได้ไม่จำกัด |
| `STATE_FILE` แยกไฟล์ | ถ้าใช้ไฟล์เดียวกับ staging PIN จะถูกนับว่า "แจ้งแล้ว" ผิดรอบ |
| ตรวจภาระ DB | รายงานเป็น SELECT เดียว/ชั่วโมง — ถ้า PIN เยอะมาก ให้ดู plan/explain ก่อน

---

## ถ้าเครื่อง Prod ต้องต่อ Tunnel

### ทางที่ดีที่สุด: รันงานบนเครื่อง Prod เอง (ไม่ต้อง tunnel สำหรับตัวงาน)

คอนเทนเนอร์บน prod server คุย API/DB ภายในได้เลย — tunnel ใช้เฉพาะตอนคุณเข้าไปสั่งงาน

```bash
ssh user@prod
cd /opt/quota-alert && ENV_FILE=.env.prod node quota-alert-line.js --check
```

> ในกรณีนี้ `API_BASE_URL` ใช้ชื่อภายใน (เช่น `https://api.internal`) — **ไม่ต้องผ่าน tunnel**

### ทางที่ 2: ทดสอบจากโน้ตบุ๊กผ่าน SSH local port-forward

ต้องเปิด 2 ช่อง: **API** (ใช้ทุกชั่วโมง) และ **DB** (ใช้ครั้งเดียวตอนลงทะเบียน report)

**Linux / macOS**
```bash
ssh -N -L 8443:prod-api.internal:443 -L 15432:prod-db:5432 user@bastion
# เพิ่มใน /etc/hosts:  127.0.0.1 prod-api.internal
```

**Windows (PowerShell)**
```powershell
ssh -N -L 8443:prod-api.internal:443 -L 15432:prod-db:5432 user@bastion
# แก้ C:\Windows\System32\drivers\etc\hosts (Run as Administrator)
#   127.0.0.1 prod-api.internal
```

`.env.prod`
```env
API_BASE_URL=https://prod-api.internal:8443
```

```bash
ENV_FILE=.env.prod node quota-alert-line.js --check
psql "postgres://user:pass@127.0.0.1:15432/dbname" -f register-report.sql
```

**ทำไมต้องใช้ hosts file** — เพื่อให้ชื่อใน certificate (SNI) ตรงกับ cert จริง → **ไม่ต้องปิดการตรวจ TLS**

| ห้าม | เพราะ |
|---|---|
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | ปิดการตรวจ cert ทั้งโปรเซส → เสี่ยงถูกดักกลางทาง |
| ใส่ `IP` แทนชื่อใน `API_BASE_URL` | cert จะไม่ตรงชื่อ → ต้องปิด TLS |

### ตรวจก่อนว่าเครื่องที่จะรัน ออกเน็ตไป LINE ได้

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $LINE_CHANNEL_TOKEN" https://api.line.me/v2/bot/info
```
`200` = token ใช้ได้และออกเน็ตได้ · `401` = token ผิด · ค้าง/ไม่ตอบ = firewall บล็อกออก

---

## รัน 24/7 — เลือกเครื่องที่เปิดตลอด

| ทาง | เหมาะกับ | ข้อดี | ข้อเสีย |
|---|---|---|---|
| **Linux + systemd timer** ⭐ | VPS/server ที่มีอยู่ | แม่นเวลา, `Persistent=true` รันชดเชยเมื่อเครื่องกลับมา, ดู log ผ่าน journalctl | ต้องมี server |
| **Docker (`restart: unless-stopped`)** | host ไหนก็ได้ที่มี Docker | ย้ายเครื่องง่าย, ลูปเองในคอนเทนเนอร์ | ต้องมี Docker |
| **Windows Task Scheduler** | เครื่อง Windows ที่เปิดตลอด | ไม่ต้องติดตั้งอะไรเพิ่ม (มี `install-task.ps1`) | **โน้ตบุ๊กหลับ/ปิด = ขาดรอบนั้น** |
| cron ธรรมดา | Linux | ง่ายสุด | ไม่รันชดเชยถ้าเครื่องปิดตอนถึงเวลา |

> ⚠️ หลักคัญ: ต้องเป็นเครื่องที่ **เปิดตลอด 24/7** — โน้ตบุ๊กส่วนตัวไม่เหมาะ (sleep/ปิดเครื่อง = แจ้งเตือนขาด)

### Linux — systemd (แนะนำ)

```bash
sudo mkdir -p /opt/quota-alert && sudo cp -r ./* /opt/quota-alert/
sudo useradd -r -s /usr/sbin/nologin quotaalert || true
sudo chown -R quotaalert:quotaalert /opt/quota-alert
sudo chmod 600 /opt/quota-alert/.env /opt/quota-alert/token-store.json

sudo cp /opt/quota-alert/quota-alert.service /opt/quota-alert/quota-alert.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quota-alert.timer

systemctl list-timers quota-alert.timer      # ดูรอบถัดไป
journalctl -u quota-alert.service -n 30      # ดู log
```

### Docker

```bash
mkdir -p data && cp token-store.json data/     # seed token บนเครื่องนี้
docker compose up -d --build
docker compose logs -f --tail 30
```

### Windows — Task Scheduler

ดูหัวข้อถัดไป (มีสคริปต์ `install-task.ps1` ติดตั้งให้อัตโนมัติ)

---

## Windows — Task Scheduler (กรณีรันบนเครื่อง Windows)

มีไฟล์ `run-quota-alert.cmd` (cd เข้าโฟลเดอร์เอง + เก็บ log + หมุน log) และ **`install-task.ps1`** ที่ตั้งค่าที่จำเป็นให้ครบ

```powershell
cd C:\Programing\Hi-Cool\quota-alert
powershell -ExecutionPolicy Bypass -File .\install-task.ps1
```

สคริปต์จะตั้งให้: ทุก 1 ชั่วโมงไม่มีวันสิ้นสุด · **StartWhenAvailable** (เครื่องหลับแล้วตื่น → รันชดเชย) ·
ไม่หยุดเมื่อใช้แบตเตอรี่ · ไม่เปิดซ้อนรอบ · **S4U** (รันได้แม้ไม่ได้ login)

ทางเลือกแบบ manual:
```powershell
schtasks /Create /SC HOURLY /TN "QuotaAlertLine" ^
  /TR "C:\Programing\Hi-Cool\quota-alert\run-quota-alert.cmd" ^
  /ST 00:00 /F

# ทดสอบสั่งรันทันที
schtasks /Run /TN "QuotaAlertLine"

# ดูสถานะ / ลบ
schtasks /Query /TN "QuotaAlertLine" /V /FO LIST
schtasks /Delete /TN "QuotaAlertLine" /F
```

ข้อควรรู้:
- ถ้าเลือก "Run whether user is logged on or not" ต้องบันทึกรหัสผ่าน (หรือใช้ SYSTEM)
- **โน้ตบุ๊กหลับ/ปิด = ไม่มีรอบนั้น** → งานแจ้งเตือนควรอยู่บนเครื่องที่เปิดตลอด (VPS/server)
- log อยู่ที่ `quota-alert.log` ข้างสคริปต์ (ตัดที่ ~5 MB)

---

## systemd timer (ทางเลือกแทน cron)

`/etc/systemd/system/quota-alert.service`
```ini
[Unit]
Description=Quota alert → LINE

[Service]
Type=oneshot
WorkingDirectory=/opt/quota-alert
EnvironmentFile=/opt/quota-alert/.env
ExecStart=/usr/bin/node quota-alert-line.js
```

`/etc/systemd/system/quota-alert.timer`
```ini
[Unit]
Description=Hourly quota alert

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now quota-alert.timer
journalctl -u quota-alert -n 50
```
