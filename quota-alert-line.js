#!/usr/bin/env node
/**
 * quota-alert-line.js
 * ---------------------------------------------------------------------------
 * แจ้งเตือนโควตาข้อมูลของ PIN ทาง LINE — รันทุก 1 ชั่วโมงด้วย cron
 *
 * หลักการ
 *   1. เรียก report `quota_alert.pins` ผ่าน admin API (report engine)
 *      -> SQL กรอง revoked/หมดอายุออกให้แล้ว, คืน PIN + quota + used
 *   2. คิดระดับของแต่ละ PIN ฝั่งนี้: ok (<70%) -> near (>=70%) -> full (>=100%)
 *   3. แจ้งเฉพาะเมื่อ "ระดับสูงขึ้น" — 1 PIN ได้ 1 ครั้งต่อระดับ
 *      (ซื้อแพ็กใหม่/ยอดรีเซ็ต -> ระดับลดลง = รีเซ็ตเงียบ ๆ ไม่แจ้ง)
 *   4. ส่งรวมเป็นข้อความเดียวต่อรอบ (ไม่ส่งเลยถ้าไม่มีใครข้ามระดับ)
 *
 * การยืนยันตัวตน (เลือกด้วย env AUTH)
 *   AUTH=logto  LOGTO_ENDPOINT + LOGTO_CLIENT_ID + LOGTO_CLIENT_SECRET
 *               (+ LOGTO_RESOURCE / LOGTO_SCOPE ถ้า API ต้องการ)
 *   AUTH=token  ACCESS_TOKEN=<bearer ที่ยังไม่หมดอายุ>   (ใช้ทดสอบเร็ว ๆ)
 *   AUTH=db     DATABASE_URL=postgres://...             (ต่อ DB ตรง; ต้อง npm i pg)
 *
 * ทดสอบโดยไม่ต้องมี credential ใด ๆ
 *   node quota-alert-line.js --selftest
 *
 * ไม่มี dependency ภายนอก (ใช้ fetch ของ Node 18+)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const RANK = { ok: 0, near: 1, full: 2 };

/**
 * โหลดไฟล์ .env แบบง่าย ๆ (ไม่ต้องใช้ dotenv)
 * - ค่าที่ export ไว้ในเครื่อง "ชนะ" ค่าในไฟล์เสมอ
 * - รองรับ comment (#), ค่าที่มีเครื่องหมายคำพูด, บรรทัดว่าง
 * - ตั้ง ENV_FILE=<path> เพื่อใช้ไฟล์อื่น
 */
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, '.env');
const ENV_LOADED = loadDotEnv(ENV_FILE);

const env = process.env;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const cfg = {
  apiBase: (env.API_BASE_URL || '').replace(/\/+$/, ''),
  reportName: env.REPORT_NAME || 'quota_alert.pins',
  pageSize: Math.min(Math.max(num(env.PAGE_SIZE, 500), 1), 500), // engine จำกัด 500
  nearPct: num(env.NEAR_PCT, 70),
  // แจ้งเมื่อ "โควตาถูกเติม/เปลี่ยน" แม้ระดับใหม่จะต่ำกว่าเกณฑ์ (เปิดเป็นค่าเริ่มต้น)
  // ปิดด้วย NOTIFY_QUOTA_CHANGE=0 (เช่น ช่วงต่ออายุรายเดือนที่เปลี่ยนโควตาทุก PIN)
  notifyQuotaChange: !['0', 'false', 'no'].includes((env.NOTIFY_QUOTA_CHANGE || '1').toLowerCase()),
  auth: (env.AUTH || 'logto').toLowerCase(),
  accessToken: env.ACCESS_TOKEN || '',
  logto: {
    endpoint: (env.LOGTO_ENDPOINT || '').replace(/\/+$/, ''),
    clientId: env.LOGTO_CLIENT_ID || '',
    clientSecret: env.LOGTO_CLIENT_SECRET || '',
    resource: env.LOGTO_RESOURCE || '',
    scope: env.LOGTO_SCOPE || '',
    // /auth/refresh ไม่บอก expires_in -> ใช้ค่านี้เป็นอายุฝั่งเรา (วินาที)
    // ตั้งให้ < 1 ชั่วโมง เพื่อให้รอบ cron ถัดไปแลกใหม่เสมอ
    apiTtlSec: num(env.API_TOKEN_TTL_SEC, 2700),
  },
  refresh: {
    // logto = เรียก /oidc/token ตรง (ต้องมี client_secret ถ้า app เป็น confidential)
    // api   = ให้ backend แลกให้ที่ POST /auth/refresh (backend ถือ client_secret เอง)
    via: (env.REFRESH_VIA || 'api').toLowerCase(),
    token: env.REFRESH_TOKEN || '',
    tokenFile: env.REFRESH_TOKEN_FILE || path.join(__dirname, 'token-store.json'),
    clientId: env.LOGTO_CLIENT_ID || '',
    clientSecret: env.LOGTO_CLIENT_SECRET || '', // public client: ไม่ต้องใส่
    scope: env.LOGTO_SCOPE || '',
    resource: env.LOGTO_RESOURCE || '',
  },
  databaseUrl: env.DATABASE_URL || '',
  line: {
    token: env.LINE_CHANNEL_TOKEN || '',
    groupId: env.LINE_GROUP_ID || '',
    endpoint: env.LINE_ENDPOINT || 'https://api.line.me/v2/bot/message/push',
  },
  statePath: env.STATE_FILE || path.join(__dirname, 'state.json'),
  lockPath: env.LOCK_FILE || path.join(__dirname, '.quota-alert.lock'),
  dryRun: ['1', 'true', 'yes'].includes((env.DRY_RUN || '').toLowerCase()),
  verbose: ['1', 'true', 'yes'].includes((env.VERBOSE || '').toLowerCase()),
  displayTz: env.DISPLAY_TZ || 'Asia/Bangkok',
  httpTimeoutMs: num(env.HTTP_TIMEOUT_MS, 20000),
  envFile: ENV_LOADED ? ENV_FILE : null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function log(...args) {
  console.error(new Date().toISOString(), ...args);
}

function debug(...args) {
  if (cfg.verbose) log('[debug]', ...args);
}

/** 1e9 = 1 GB (ฐานเดียวกับ backend ที่ใช้โควตาเป็น MB/1000) */
function gb(bytes) {
  return (Number(bytes || 0) / 1e9).toFixed(2);
}

function pct(row) {
  const quota = Number(row.quota_bytes || 0);
  const used = Number(row.used_bytes || 0);
  if (!(quota > 0)) return null;
  return (used * 100) / quota;
}

function stamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.displayTz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.httpTimeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const message = typeof body === 'string' ? body : JSON.stringify(body);
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${url} — ${String(message).slice(0, 400)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

// ─── Refresh-token store (Logto หมุน refresh token ทุกครั้ง) ─────────────────
//
// token-store.json: { refresh_token, access_token, expires_at, updated_at }
// - เขียนแบบ atomic + chmod 600 (ไฟล์มีข้อมูลที่ใช้ขอ token ได้)
// - ถ้า access_token ยังไม่หมดอายุ (>2 นาที) ใช้ซ้ำ — ไม่ rotate โดยไม่จำเป็น
// - ถ้าต้อง refresh: บันทึก token ชุดใหม่ "ทันทีก่อน" เรียก API ใด ๆ
//   เพราะ refresh token เก่าจะถูกยกเลิกทันทีเมื่อใช้

function loadTokenStore() {
  try {
    const raw = fs.readFileSync(cfg.refresh.tokenFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code !== 'ENOENT') log('อ่าน token store ไม่ได้:', err.message);
    return {};
  }
}

function saveTokenStore(store) {
  const dir = path.dirname(cfg.refresh.tokenFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cfg.refresh.tokenFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cfg.refresh.tokenFile);
  try {
    fs.chmodSync(cfg.refresh.tokenFile, 0o600);
  } catch {
    /* ignore (บาง FS ไม่รองรับ) */
  }
}

async function refreshAccessToken() {
  const store = loadTokenStore();
  const now = Date.now();

  // ยังใช้ได้อยู่ -> ใช้ซ้ำ ไม่ rotate
  if (store.access_token && store.expires_at && store.expires_at - now > 120_000) {
    debug('ใช้ access_token ที่ยังไม่หมดอายุ (เหลือ', Math.round((store.expires_at - now) / 1000), 'วินาที)');
    return store.access_token;
  }

  const refreshToken = store.refresh_token || cfg.refresh.token;
  if (!refreshToken) {
    throw new Error(
      'ไม่มี refresh token — ตั้ง REFRESH_TOKEN ใน .env หรือรัน: node quota-alert-line.js --set-refresh-token <token>',
    );
  }

  // ── โหมด api: ให้ backend แลก token ให้ (backend ถือ client_secret เอง) ──
  // ใช้เมื่อ app ใน Logto เป็น confidential และเราไม่มี client_secret
  if (cfg.refresh.via === 'api') {
    if (!cfg.apiBase) throw new Error('REFRESH_VIA=api ต้องตั้ง API_BASE_URL');
    let body;
    try {
      body = await fetchJson(`${cfg.apiBase}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch (err) {
      const msg = String(err.message);
      if (msg.includes('invalid_grant')) {
        throw new Error(
          'Logto ปฏิเสธ refresh token (invalid_grant) — เกิดได้ 3 อย่าง:\n' +
            '   1) token ถูกใช้/rotate ไปแล้ว (ก็อปมาจากแท็บที่ยังเปิดอยู่ → ขอใหม่จาก session ที่จะปิดทันที)\n' +
            '   2) token มาจาก Logto tenant/client คนละตัวกับ API นี้ (ตรวจด้วย --token-info)\n' +
            '   3) token หมดอายุ หรือ session ถูก revoke (logout/เปลี่ยนรหัส)\n' +
            `   ต้นฉบับ: ${msg.slice(0, 220)}`,
        );
      }
      throw new Error(`แลก token ผ่าน API ไม่สำเร็จ (${msg.slice(0, 240)})`);
    }
    if (!body || !body.access_token) {
      throw new Error(`/auth/refresh ไม่คืน access_token: ${JSON.stringify(body).slice(0, 300)}`);
    }
    saveTokenStore({
      refresh_token: body.refresh_token || refreshToken,
      access_token: body.access_token,
      expires_at: Date.now() + Math.max(60, cfg.refresh.apiTtlSec) * 1000,
      updated_at: new Date().toISOString(),
    });
    debug('แลก token ผ่าน API สำเร็จ — บันทึกชุดใหม่แล้ว');
    return body.access_token;
  }

  const { endpoint, clientId, clientSecret, resource, scope } = { endpoint: cfg.logto.endpoint, ...cfg.refresh };
  if (!endpoint || !clientId) {
    throw new Error('AUTH=refresh ต้องตั้ง LOGTO_ENDPOINT และ LOGTO_CLIENT_ID');
  }

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (resource) form.set('resource', resource);
  if (scope) form.set('scope', scope);

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }

  let body;
  try {
    body = await fetchJson(`${endpoint}/oidc/token`, { method: 'POST', headers, body: form.toString() });
  } catch (err) {
    throw new Error(
      `refresh ไม่สำเร็จ (${err.message}) — ถ้าเป็น invalid_grant แปลว่า refresh token ถูกใช้ไปแล้ว/หมดอายุ ต้องขอใหม่`,
    );
  }
  if (!body || !body.access_token) {
    throw new Error(`Logto ไม่คืน access_token: ${JSON.stringify(body).slice(0, 300)}`);
  }

  // ⚠️ บันทึกทันที: refresh token เก่าใช้ไม่ได้แล้ว
  saveTokenStore({
    refresh_token: body.refresh_token || refreshToken,
    access_token: body.access_token,
    expires_at: Date.now() + (Number(body.expires_in) || 300) * 1000,
    updated_at: new Date().toISOString(),
  });
  debug('refresh สำเร็จ — บันทึก token ชุดใหม่แล้ว (expires_in =', body.expires_in, ')');
  return body.access_token;
}

async function getAccessToken() {
  if (cfg.auth === 'token') {
    if (!cfg.accessToken) throw new Error('AUTH=token ต้องตั้ง ACCESS_TOKEN');
    return cfg.accessToken;
  }

  if (cfg.auth === 'logto') {
    const { endpoint, clientId, clientSecret, resource, scope } = cfg.logto;
    if (!endpoint || !clientId || !clientSecret) {
      throw new Error('AUTH=logto ต้องตั้ง LOGTO_ENDPOINT, LOGTO_CLIENT_ID, LOGTO_CLIENT_SECRET');
    }
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (resource) form.set('resource', resource);
    if (scope) form.set('scope', scope);

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = await fetchJson(`${endpoint}/oidc/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!body || !body.access_token) {
      throw new Error(`Logto ไม่คืน access_token: ${JSON.stringify(body).slice(0, 300)}`);
    }
    debug('ได้ Logto token แล้ว (expires_in =', body.expires_in, ')');
    return body.access_token;
  }

  if (cfg.auth === 'refresh') return refreshAccessToken();

  if (cfg.auth === 'db') return null; // ไม่ต้องใช้ token

  throw new Error(`AUTH ไม่รู้จัก: ${cfg.auth} (เลือก refresh | logto | token | db)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ตัวตนที่ token ใช้อยู่: GET /admin/get-me
// ─────────────────────────────────────────────────────────────────────────────

async function whoami(print = true) {
  if (cfg.auth === 'db') {
    if (print) console.log('ℹ️  โหมด db ไม่มีตัวตนผู้ใช้ (ต่อฐานข้อมูลตรง)');
    return null;
  }
  if (!cfg.apiBase) throw new Error('ต้องตั้ง API_BASE_URL');

  const token = await getAccessToken();
  const me = await fetchJson(`${cfg.apiBase}/admin/get-me`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });

  if (print) {
    console.log(`👤 ${me.email || '(ไม่มีอีเมล)'} · role=${me.role ?? '-'} · id=${me.id ?? '-'}`);
  }
  return me;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data source
// ─────────────────────────────────────────────────────────────────────────────

/** เรียก report ผ่าน admin API ทีละหน้า จนครบ `total` */
async function fetchViaReport(token) {
  if (!cfg.apiBase) throw new Error('ต้องตั้ง API_BASE_URL');

  const rows = [];
  let page = 1;
  let total = Infinity;

  while (rows.length < total) {
    const body = await fetchJson(`${cfg.apiBase}/admin/reports/${cfg.reportName}/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ params: {}, page, page_size: cfg.pageSize }),
    }).catch((err) => {
      if (String(err.message).includes('404')) {
        throw new Error(
          `รายงาน '${cfg.reportName}' ยังไม่มีในฐานข้อมูลของ API นี้ (404)\n` +
            '   วิธีแก้: รัน register-report.sql กับ DB ที่ API ตัวนี้ใช้\n' +
            '     psql "$DATABASE_URL" -f register-report.sql\n' +
            `   ตรวจว่าเข้าแล้ว: psql "$DATABASE_URL" -c "select name from report_query where name='${cfg.reportName}'"\n` +
            '   ⚠️ ต้องเป็น DB ของ environment เดียวกับ API_BASE_URL ' + `(${cfg.apiBase})`,
        );
      }
      throw err;
    });

    const batch = Array.isArray(body?.data) ? body.data : [];
    total = Number(body?.total ?? batch.length);
    rows.push(...batch);
    debug(`page ${page}: ได้ ${batch.length} แถว (สะสม ${rows.length}/${total})`);

    if (batch.length === 0) break;
    page += 1;
  }

  return rows;
}

/** โหมดสำรอง: ต่อ DB ตรง (อ่านอย่างเดียว) */
async function fetchViaDatabase() {
  if (!cfg.databaseUrl) throw new Error('AUTH=db ต้องตั้ง DATABASE_URL');

  let pg;
  try {
    pg = require('pg');
  } catch {
    throw new Error('AUTH=db ต้องติดตั้งไดรเวอร์ก่อน: npm install pg');
  }

  const sqlFile = path.join(__dirname, 'quota-alert.pins.sql');
  const raw = fs.readFileSync(sqlFile, 'utf8');
  const sql = raw
    .replace(/^\s*--.*$/gm, '')            // ตัดคอมเมนต์
    .replace(/:_limit/g, '$1')
    .replace(/:_offset/g, '$2');

  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    const all = [];
    let offset = 0;
    for (;;) {
      const { rows } = await client.query(sql, [cfg.pageSize, offset]);
      all.push(...rows);
      if (rows.length < cfg.pageSize) break;
      offset += cfg.pageSize;
    }
    return all;
  } finally {
    await client.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ระดับ + การตัดสินใจแจ้ง
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ระดับของ PIN หนึ่งแถว
 * - เทียบด้วยจำนวนเต็ม (used*100 >= quota*70) เพื่อไม่ให้ทศนิยมทำเกณฑ์เพี้ยน
 * - คืน null เมื่อ quota_bytes <= 0 (คิด % ไม่ได้)
 */
function levelOf(row, nearPct = cfg.nearPct) {
  const quota = Number(row.quota_bytes || 0);
  const used = Number(row.used_bytes || 0);
  if (!(quota > 0)) return null;
  if (used >= quota) return 'full';
  if (used * 100 >= quota * nearPct) return 'near';
  return 'ok';
}

/**
 * เทียบกับ state เดิม -> รายการที่ต้องแจ้ง + state ใหม่
 *
 * กติกา:
 *  - ระดับสูงขึ้น (ok→near, near→full)                 -> แจ้ง
 *  - ระดับเท่าเดิม                                     -> เงียบ
 *  - **quota เปลี่ยน (เติม/ลด) -> เริ่มรอบใหม่**        -> แจ้งตามระดับใหม่ (near/full)
 *  - ระดับลดลงอย่างเดียว (ใช้ยอดรีเซ็ต)                -> เงียบ
 *  - PIN หายจากรายการ                                  -> ลบออกจาก state
 *
 * ต้องเก็บ `quota_bytes` ใน state ด้วย ไม่งั้นแยก "เติมโควตา" ออกจาก "ระดับลด" ไม่ได้
 */
function plan(rows, prevState, nearPct = cfg.nearPct) {
  const prevPins = (prevState && prevState.pins) || {};
  const next = { version: 1, updated_at: new Date().toISOString(), pins: {} };
  const transitions = [];
  const quotaChanges = [];

  for (const row of rows) {
    const pin = String(row.pin_code ?? '');
    if (!pin) continue;

    const level = levelOf(row, nearPct);
    if (!level) continue; // ไม่มีโควตา คิด % ไม่ได้ -> ข้าม

    const prev = prevPins[pin] || null;
    const prevLevel = (prev && prev.level) || 'ok';
    const quota = Number(row.quota_bytes || 0);
    const prevQuota = prev && prev.quota_bytes != null ? Number(prev.quota_bytes) : null;

    // เติม/เปลี่ยนโควตา = เริ่มรอบใหม่ (เทียบจาก ok) — state เก่าที่ไม่มี quota_bytes ถือว่าไม่เปลี่ยน
    const quotaChanged = prevQuota !== null && prevQuota !== quota;
    const base = quotaChanged ? 'ok' : prevLevel;

    next.pins[pin] = { level, quota_bytes: quota, at: new Date().toISOString() };

    if (quotaChanged) {
      quotaChanges.push({ row, level, prevQuota, quota });
    }

    if (RANK[level] > RANK[base]) {
      transitions.push({
        row,
        level,
        before: base,
        reason: quotaChanged ? 'quota_changed' : 'level_up',
      });
    }
  }

  return { transitions, quotaChanges, next };
}

// ─────────────────────────────────────────────────────────────────────────────
// ข้อความ — จัดกลุ่มตาม "เรือ" ก่อน แล้วค่อยแยก 🔴 หมดแล้ว / 🟠 ใกล้หมด ภายในเรือ
// ─────────────────────────────────────────────────────────────────────────────

/** ชื่อเรือที่ใช้แสดง (ถ้าไม่มีชื่อ ใช้ vessel_id หรือ "ไม่ระบุเรือ") */
function vesselLabel(row) {
  if (row.vessel_name) return String(row.vessel_name);
  if (row.vessel_id !== null && row.vessel_id !== undefined) return `เรือ #${row.vessel_id}`;
  return 'ไม่ระบุเรือ';
}

/** หมายเหตุย่อ: ตัดที่ 40 ตัวอักษร (กันข้อความบวม) */
function remarkOf(row) {
  const raw = row.remark ? String(row.remark).trim().replace(/\s+/g, ' ') : '';
  if (!raw) return '';
  return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
}

/**
 * บรรทัดของ PIN หนึ่งรายการ (มี indent อยู่ใต้หัวข้อเรือ)
 * รูปแบบ: <สี> <PIN> · <remark> · <used>/<quota> GB (<pct>)
 * สีบอกระดับ (🔴 หมดแล้ว / 🟠 ใกล้หมด) — ไม่ต้องมีคำกำกับหน้า PIN
 */
function lineFor(entry) {
  const { row, level } = entry;
  const icon = level === 'full' ? '🔴' : '🟠';
  const p = pct(row);
  const pctText = p === null ? '-' : `${p.toFixed(1)}%`;
  const remark = remarkOf(row);
  const parts = [String(row.pin_code), remark, `${gb(row.used_bytes)}/${gb(row.quota_bytes)} GB (${pctText})`]
    .filter(Boolean);
  return `  ${icon} ${parts.join(' · ')}`;
}

function buildMessage(transitions, now = new Date(), quotaChanges = []) {
  const showChanges = cfg.notifyQuotaChange && quotaChanges.length > 0;
  if (transitions.length === 0 && !showChanges) return null;

  // 1) จัดกลุ่มตามเรือ
  const groups = new Map();
  for (const entry of transitions) {
    const label = vesselLabel(entry.row);
    if (!groups.has(label)) groups.set(label, { label, weight: 0, items: [] });
    const group = groups.get(label);
    group.items.push(entry);
    group.weight = Math.max(group.weight, RANK[entry.level]); // ให้เรือที่มี "หมดแล้ว" ขึ้นก่อน
  }

  // 2) เรียงเรือ: severity มากก่อน แล้วตามชื่อ
  const ordered = [...groups.values()].sort(
    (a, b) => b.weight - a.weight || a.label.localeCompare(b.label, 'th'),
  );

  const lines = [`📊 แจ้งเตือนโควตาข้อมูล — ${stamp(now)}`];
  let fullCount = 0;
  let nearCount = 0;

  for (const group of ordered) {
    // ภายในเรือ: 🔴 ก่อน 🟠 แล้วเรียงตามรหัส PIN
    group.items.sort(
      (a, b) => RANK[b.level] - RANK[a.level] || String(a.row.pin_code).localeCompare(String(b.row.pin_code)),
    );

    const vesselFull = group.items.filter((t) => t.level === 'full').length;
    const vesselNear = group.items.length - vesselFull;
    fullCount += vesselFull;
    nearCount += vesselNear;

    const badge = [vesselFull ? `🔴 ${vesselFull}` : '', vesselNear ? `🟠 ${vesselNear}` : ''].filter(Boolean).join(' · ');
    lines.push('', `🚢 ${group.label} (${badge})`);
    for (const entry of group.items) lines.push(lineFor(entry));
  }

  if (transitions.length) {
    lines.push('', `รวม 🔴 หมดแล้ว ${fullCount} · 🟠 ใกล้หมด ${nearCount} รายการ`);
  }

  if (showChanges) {
    lines.push('', `♻️ ปรับโควตา ${quotaChanges.length} รายการ`);
    for (const c of quotaChanges) {
      const remark = remarkOf(c.row);
      const head = [String(c.row.pin_code), remark].filter(Boolean).join(' · ');
      lines.push(
        `  • ${head} · ${gb(c.prevQuota)} → ${gb(c.quota)} GB` +
          (c.level === 'ok' ? '' : ` (ตอนนี้ ${pct(c.row) === null ? '-' : pct(c.row).toFixed(1) + '%'})`),
      );
    }
  }

  return lines.join('\n').trimEnd();
}

/** แบ่งข้อความยาวเกิน 4500 ตัวอักษร (LINE จำกัด 5000/ข้อความ, 5 ข้อความ/ครั้ง) */
function chunkMessage(text, limit = 4500) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// LINE
// ─────────────────────────────────────────────────────────────────────────────

async function pushLine(text) {
  if (cfg.dryRun) {
    log('[dry-run] ข้อความที่จะส่ง:\n' + text);
    return;
  }
  if (!cfg.line.token || !cfg.line.groupId) {
    const missing = [!cfg.line.token && 'LINE_CHANNEL_TOKEN', !cfg.line.groupId && 'LINE_GROUP_ID']
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `ยังไม่ได้ตั้ง ${missing} — ตรวจไฟล์ ${ENV_FILE} (ต้องมีบรรทัด ${missing}=...) ` +
      'หรือ export ค่าในเครื่องก่อนรัน',
    );
  }

  const chunks = chunkMessage(text).slice(0, 5);
  const messages = chunks.map((chunk) => ({ type: 'text', text: chunk }));

  await fetchJson(cfg.line.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.line.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ to: cfg.line.groupId, messages }),
  });
  log(`ส่ง LINE สำเร็จ (${messages.length} ข้อความ)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// State + lock
// ─────────────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    const raw = fs.readFileSync(cfg.statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.pins) return { version: 1, pins: {} };
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') log('อ่าน state ไม่ได้ จะเริ่มใหม่:', err.message);
    return { version: 1, pins: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(cfg.statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cfg.statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, cfg.statePath); // atomic
}

function acquireLock() {
  const dir = path.dirname(cfg.lockPath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const fd = fs.openSync(cfg.lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // lock ค้างเกิน 10 นาที (รอบก่อนตายกลางทาง) -> เก็บกวาดแล้วลองใหม่
    const ageMs = Date.now() - fs.statSync(cfg.lockPath).mtimeMs;
    if (ageMs > 10 * 60 * 1000) {
      log('พบ lock ค้าง', Math.round(ageMs / 1000), 'วินาที — ลบทิ้งแล้วรันต่อ');
      fs.unlinkSync(cfg.lockPath);
      return acquireLock();
    }
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(cfg.lockPath);
  } catch {
    /* ไม่มีก็ไม่เป็นไร */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRows() {
  if (cfg.auth === 'db') return fetchViaDatabase();
  const token = await getAccessToken();
  return fetchViaReport(token);
}

async function main() {
  if (!acquireLock()) {
    log('ข้ามรอบนี้: รอบก่อนยังทำงานอยู่ (lock)');
    return 0;
  }

  try {
    const rows = await fetchRows();
    log(`ดึงข้อมูลได้ ${rows.length} PIN`);

    const prev = loadState();
    const { transitions, quotaChanges, next } = plan(rows, prev);
    const byQuota = transitions.filter((t) => t.reason === 'quota_changed').length;
    log(
      `ต้องแจ้ง ${transitions.length} รายการ (full ${transitions.filter((t) => t.level === 'full').length}, ` +
        `near ${transitions.filter((t) => t.level === 'near').length}` +
        (byQuota ? `, จากการเปลี่ยนโควตา ${byQuota}` : '') +
        ')',
    );

    if (quotaChanges.length) {
      log(`ตรวจพบการเปลี่ยนโควตา ${quotaChanges.length} รายการ${cfg.notifyQuotaChange ? ' (จะแจ้ง)' : ' (ไม่แจ้ง — เปิดด้วย NOTIFY_QUOTA_CHANGE=1)'}`);
    }

    const message = buildMessage(transitions, new Date(), quotaChanges);
    if (message) {
      await pushLine(message);
    } else {
      log('ไม่มีใครข้ามระดับ — ไม่ส่งข้อความ');
    }

    if (!cfg.dryRun) saveState(next);
    return 0;
  } finally {
    releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test (ไม่ต้องมี credential): node quota-alert-line.js --selftest
// ─────────────────────────────────────────────────────────────────────────────

function selftest() {
  const mk = (pin, quotaBytes, usedBytes, vessel = null) => ({
    pin_code: pin,
    quota_bytes: quotaBytes,
    used_bytes: usedBytes,
    vessel_name: vessel,
  });

  // เกณฑ์ระดับ
  assert.strictEqual(levelOf(mk('A', 10e9, 6.99e9)), 'ok');
  assert.strictEqual(levelOf(mk('A', 10e9, 7e9)), 'near');      // 70% พอดี
  assert.strictEqual(levelOf(mk('A', 10e9, 9.99e9)), 'near');
  assert.strictEqual(levelOf(mk('A', 10e9, 10e9)), 'full');     // 100% พอดี
  assert.strictEqual(levelOf(mk('A', 10e9, 13e9)), 'full');     // เกิน 100%
  assert.strictEqual(levelOf(mk('A', 0, 5e9)), null);           // ไม่มีโควตา

  // รอบที่ 1: P1 near, P2 full, P3 ok -> แจ้ง 2
  const rows = [mk('P1', 10e9, 7.5e9, 'MANDARIN QUEEN 9'), mk('P2', 10e9, 10e9), mk('P3', 10e9, 1e9)];
  let state = { version: 1, pins: {} };
  let step = plan(rows, state);
  assert.strictEqual(step.transitions.length, 2, 'รอบแรกต้องแจ้ง 2 รายการ');
  assert.deepStrictEqual(step.transitions.map((t) => t.level).sort(), ['full', 'near']);

  // รอบที่ 2: ข้อมูลเดิม -> ต้องไม่แจ้งซ้ำ (1 PIN 1 ครั้งต่อระดับ)
  step = plan(rows, step.next);
  assert.strictEqual(step.transitions.length, 0, 'รอบเดิมต้องไม่แจ้งซ้ำ');
  state = step.next;

  // รอบที่ 3: P1 ใช้เพิ่มเป็น 100% -> แจ้งเฉพาะ near -> full
  const grew = [mk('P1', 10e9, 10e9, 'MANDARIN QUEEN 9'), mk('P2', 10e9, 10e9), mk('P3', 10e9, 1e9)];
  step = plan(grew, state);
  assert.strictEqual(step.transitions.length, 1, 'ต้องแจ้งเฉพาะ P1 ที่ข้ามเป็น full');
  assert.strictEqual(step.transitions[0].row.pin_code, 'P1');
  state = step.next;

  // รอบที่ 4: P2 ซื้อแพ็กใหม่ (ใช้ลดลง) -> ไม่แจ้ง และ state รีเซ็ตเป็น ok
  const topped = [mk('P1', 10e9, 10e9), mk('P2', 10e9, 1e9), mk('P3', 10e9, 1e9)];
  step = plan(topped, state);
  assert.strictEqual(step.transitions.length, 0, 'ยอดลดลงต้องไม่แจ้ง');
  assert.strictEqual(step.next.pins.P2.level, 'ok', 'state ต้องรีเซ็ตเป็น ok');

  // รอบที่ 5: P2 กลับมา 75% -> แจ้ง near อีกครั้ง (รอบใหม่หลังรีเซ็ต)
  const again = [mk('P1', 10e9, 10e9), mk('P2', 10e9, 7.5e9), mk('P3', 10e9, 1e9)];
  step = plan(again, step.next);
  assert.strictEqual(step.transitions.length, 1);
  assert.strictEqual(step.transitions[0].row.pin_code, 'P2');

  // ── เคส "เติม/เปลี่ยนโควตา" = เริ่มรอบใหม่ ต้องแจ้งตามระดับใหม่ ──
  const G = 1e9;
  const pin = (quotaGb, usedGb) => ({ pin_code: 'P9', quota_bytes: quotaGb * G, used_bytes: usedGb * G });

  // เดิม 1GB/1GB = full และเคยแจ้งแล้ว -> เติม +1GB (1GB/2GB = 50%)
  let st = { version: 1, pins: { P9: { level: 'full', quota_bytes: 1 * G } } };
  let after = plan([pin(2, 1)], st);
  assert.strictEqual(after.transitions.length, 0, 'เติมแล้วระดับเป็น ok -> ไม่มีอะไรต้องแจ้ง');
  assert.strictEqual(after.next.pins.P9.level, 'ok');
  assert.strictEqual(after.next.pins.P9.quota_bytes, 2 * G, 'state ต้องจำ quota ใหม่');

  // เติมนิดเดียว: 1GB/1.2GB = 83% -> ต้องแจ้ง near แม้ระดับเดิมเป็น full
  after = plan([pin(1.2, 1)], { version: 1, pins: { P9: { level: 'full', quota_bytes: 1 * G } } });
  assert.strictEqual(after.transitions.length, 1, 'เติมโควตาแล้วต้องแจ้งตามระดับใหม่');
  assert.strictEqual(after.transitions[0].level, 'near');
  assert.strictEqual(after.transitions[0].reason, 'quota_changed');

  // เติมแล้วยังเต็ม (เช่น ลดโควตา/แก้ตัวเลข) -> ต้องแจ้ง full
  after = plan([pin(0.5, 1)], { version: 1, pins: { P9: { level: 'full', quota_bytes: 1 * G } } });
  assert.strictEqual(after.transitions.length, 1, 'โควตาลดจนเต็ม ต้องแจ้ง');
  assert.strictEqual(after.transitions[0].level, 'full');

  // โควตาเท่าเดิม + ระดับเท่าเดิม -> เงียบ (กันสแปมรายชั่วโมง)
  const same = { version: 1, pins: { P9: { level: 'near', quota_bytes: 2 * G } } };
  after = plan([pin(2, 1.5)], same);
  assert.strictEqual(after.transitions.length, 0, 'โควตาไม่เปลี่ยนและระดับเดิม -> เงียบ');

  // ใช้ยอดรีเซ็ต (quota เดิม) -> ระดับลดลง เงียบ
  after = plan([pin(2, 0.2)], same);
  assert.strictEqual(after.transitions.length, 0, 'ยอดรีเซ็ต -> เงียบ');

  // PIN หายจากรายการ -> ลบออกจาก state เงียบ ๆ
  step = plan([mk('P3', 10e9, 1e9)], step.next);
  assert.deepStrictEqual(Object.keys(step.next.pins), ['P3']);

  // ข้อความ: ต้องแยกกลุ่มตามเรือ
  const msg = buildMessage(plan(rows, { version: 1, pins: {} }).transitions, new Date('2026-11-24T07:00:00Z'));
  assert.ok(msg.includes('🚢 MANDARIN QUEEN 9 (🟠 1)'), 'ต้องมีหัวข้อย่อยของเรือ (ใกล้หมด)');
  assert.ok(msg.includes('🚢 ไม่ระบุเรือ (🔴 1)'), 'PIN ที่ไม่มีชื่อเรือต้องไปอยู่กลุ่ม "ไม่ระบุเรือ"');
  assert.ok(msg.includes('🔴 P2 · 10.00/10.00 GB (100.0%)'), 'บรรทัด 🔴 ต้องไม่มีคำกำกับหน้า PIN');
  assert.ok(msg.includes('🟠 P1 · 7.50/10.00 GB (75.0%)'), 'บรรทัด 🟠 ต้องมีตัวเลขถูกต้อง');
  assert.ok(!msg.includes('หมดแล้ว P') && !msg.includes('ใกล้หมด P'), 'ต้องไม่แสดงคำ หมดแล้ว/ใกล้หมด หน้า PIN');
  assert.ok(msg.includes('รวม 🔴 หมดแล้ว 1 · 🟠 ใกล้หมด 1 รายการ'), 'ต้องมีบรรทัดรวมท้ายข้อความ');

  // เรือที่มี "หมดแล้ว" ต้องขึ้นก่อนเรือที่มีแค่ "ใกล้หมด"
  assert.ok(msg.indexOf('ไม่ระบุเรือ') < msg.indexOf('MANDARIN QUEEN 9'), 'เรือที่มี 🔴 ต้องมาก่อน');

  // vessel_id แทนชื่อเรือ เมื่อไม่มี vessel_name
  const byId = buildMessage(plan([mk('P9', 10e9, 9e9)], { version: 1, pins: {} }).transitions, new Date());
  assert.ok(byId.includes('🚢 ไม่ระบุเรือ'), 'ไม่มีทั้งชื่อและ id -> ไม่ระบุเรือ');

  const long = Array.from({ length: 400 }, (_, i) => `🟠 ใกล้หมด PIN-${i} · 7.50/10.00 GB (75.0%)`).join('\n');
  assert.ok(chunkMessage(long).length > 1, 'ข้อความยาวต้องถูกแบ่ง');

  console.log('✅ selftest ผ่านทุกข้อ (ระดับ / dedupe / รีเซ็ต / ข้อความ / แบ่งข้อความ)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview: ดูหน้าตาข้อความด้วยข้อมูลสมมติ (ไม่เรียก API, ไม่ส่ง LINE)
//   node quota-alert-line.js --preview
// ─────────────────────────────────────────────────────────────────────────────

function preview() {
  const rows = [
    { pin_code: 'PIN-000123', quota_bytes: 10e9, used_bytes: 10e9, vessel_name: 'MANDARIN QUEEN 9', remark: 'ลูกเรือ กะดึก' },
    { pin_code: 'PIN-000789', quota_bytes: 10e9, used_bytes: 9.62e9, vessel_name: 'MANDARIN QUEEN 9', remark: null },
    { pin_code: 'PIN-000456', quota_bytes: 5e9, used_bytes: 7.1e9, vessel_name: 'SIRIUS STAR', remark: 'ทดสอบ remark ที่ยาวมากจนเกินสี่สิบตัวอักษรจะถูกตัดด้วยปีกกา' },
    { pin_code: 'PIN-000999', quota_bytes: 10e9, used_bytes: 8.4e9, vessel_id: 42 },
    { pin_code: 'PIN-001111', quota_bytes: 10e9, used_bytes: 1.2e9, vessel_name: 'MANDARIN QUEEN 9' },
  ];
  const { transitions } = plan(rows, { version: 1, pins: {} });
  console.log(buildMessage(transitions, new Date('2026-11-24T07:00:00Z')));
  console.log(`\n(${transitions.length} รายการจาก ${rows.length} PIN — PIN-001111 อยู่ที่ 12% จึงไม่ถูกแจ้ง)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ทดสอบ LINE: node quota-alert-line.js --test-line
//   ส่งข้อความสั้น ๆ เข้ากลุ่ม เพื่อยืนยันว่า token + groupId ใช้ได้
//   (ใช้ LINE_CHANNEL_TOKEN / LINE_GROUP_ID จาก .env)
// ─────────────────────────────────────────────────────────────────────────────

async function testLine() {
  const text = [
    '✅ ทดสอบการเชื่อมต่อ quota-alert',
    `เวลา: ${stamp(new Date())}`,
    'ถ้าเห็นข้อความนี้ แปลว่า token + groupId ใช้งานได้',
  ].join('\n');

  log('กำลังส่งข้อความทดสอบ' + (cfg.dryRun ? ' (dry-run)' : ''));
  await pushLine(text);
  if (!cfg.dryRun) log('เสร็จ — ไปดูในกลุ่ม LINE ได้เลย');
}

// ─────────────────────────────────────────────────────────────────────────────
// ตรวจความพร้อม: node quota-alert-line.js --check
//   ตรวจ env → auth → report ใน catalog → ดึงข้อมูลหน้าแรก (ไม่ส่ง LINE)
// ─────────────────────────────────────────────────────────────────────────────

function mask(value) {
  if (!value) return '(ไม่ได้ตั้ง)❌';
  const s = String(value);
  return `...${s.slice(-4)}`;
}

async function check() {
  const problems = [];
  const ok = (label, detail = '') => console.log(`✅ ${label}${detail ? ' — ' + detail : ''}`);
  const skipLine = ['1', 'true', 'yes'].includes((env.SKIP_LINE_CHECK || '').toLowerCase());
  const warn = (label, detail = '') => console.log(`⚠️  ${label}${detail ? ' — ' + detail : ''} (ข้ามการตรวจด้วย SKIP_LINE_CHECK=1)`);
  const bad = (label, detail = '') => {
    console.log(`❌ ${label}${detail ? ' — ' + detail : ''}`);
    problems.push(label);
  };

  console.log('── การตั้งค่า ───────────────────────────────');
  cfg.envFile
    ? ok('โหลด .env', path.basename(cfg.envFile))
    : console.log(`ℹ️  ไม่พบไฟล์ .env ที่ ${ENV_FILE} — ใช้ค่าจาก environment ที่ export ไว้`);
  if (cfg.auth === 'db') {
    ok('AUTH = db', 'DATABASE_URL ' + mask(cfg.databaseUrl));
  } else if (cfg.auth === 'refresh') {
    const store = loadTokenStore();
    const hasRefresh = Boolean(store.refresh_token || cfg.refresh.token);
    const left = store.expires_at ? Math.round((store.expires_at - Date.now()) / 1000) : null;
    ok(
      'AUTH = refresh',
      cfg.refresh.via === 'api'
        ? `via API (${cfg.apiBase || '?'})/auth/refresh — ไม่ต้องมี client_secret`
        : `via Logto ${cfg.logto.clientId || '(ไม่ได้ตั้ง)'} ${cfg.refresh.clientSecret ? mask(cfg.refresh.clientSecret) : '(public client)'}`,
    );
    hasRefresh
      ? ok('refresh token', `อยู่ใน ${path.basename(cfg.refresh.tokenFile)}`)
      : bad('refresh token', 'ยังไม่มี — รัน --set-refresh-token <token>');
    console.log(
      left === null
        ? '   access token: ยังไม่มีใน store (จะ refresh รอบนี้)'
        : `   access token: ${left > 0 ? `เหลือ ${left} วินาที (ใช้ซ้ำ)` : 'หมดอายุแล้ว (จะ refresh)'}`,
    );
  } else if (cfg.auth === 'logto') {
    ok('AUTH = logto', `client ${cfg.logto.clientId || '(ไม่ได้ตั้ง)'} ${mask(cfg.logto.clientSecret)}`);
  } else {
    ok('AUTH = token', `token ${mask(cfg.accessToken)}`);
  }

  cfg.auth === 'db'
    ? ok('API_BASE_URL', '(ไม่ใช้ในโหมด db)')
    : (cfg.apiBase ? ok('API_BASE_URL', cfg.apiBase) : bad('API_BASE_URL', 'ต้องตั้ง'));

  console.log('   report =', cfg.reportName, '| page_size =', cfg.pageSize, '| near =', cfg.nearPct + '%');
  cfg.line.token
    ? ok('LINE_CHANNEL_TOKEN', mask(cfg.line.token))
    : (skipLine ? warn('LINE_CHANNEL_TOKEN') : bad('LINE_CHANNEL_TOKEN'));
  cfg.line.groupId
    ? ok('LINE_GROUP_ID', mask(cfg.line.groupId))
    : (skipLine ? warn('LINE_GROUP_ID') : bad('LINE_GROUP_ID'));

  console.log('\n── การเชื่อมต่อ + ข้อมูล ─────────────────────');
  if (cfg.auth !== 'db' && cfg.apiBase) {
    try {
      const me = await whoami(false);
      ok('ตัวตนที่ token ใช้', `${me.email || '-'} · role=${me.role ?? '-'}`);
    } catch (err) {
      bad('ตรวจตัวตน (/admin/get-me)', err.message.slice(0, 160));
    }
  }
  let rows = [];
  try {
    rows = await fetchRows();
    ok('ดึงข้อมูลจาก report', `${rows.length} แถว`);
  } catch (err) {
    bad('เรียก API/DB ไม่สำเร็จ', err.message.slice(0, 200));
  }

  if (rows.length) {
    const levels = { ok: 0, near: 0, full: 0, unknown: 0 };
    for (const row of rows) levels[levelOf(row) || 'unknown'] += 1;
    console.log(`   ระดับ: 🔴 full ${levels.full} · 🟠 near ${levels.near} · 🟢 ok ${levels.ok} · ⚪ ไม่มีโควตา ${levels.unknown}`);

    const { transitions, quotaChanges } = plan(rows, loadState());
    console.log(`   ถ้ารัน cron จริงตอนนี้ จะแจ้ง ${transitions.length} รายการ`);
    if (quotaChanges.length) {
      console.log(`   ตรวจพบการเปลี่ยนโควตา ${quotaChanges.length} รายการ${cfg.notifyQuotaChange ? ' (จะแสดงในข้อความ)' : ' (ไม่แสดง — NOTIFY_QUOTA_CHANGE=1 เพื่อเปิด)'}`);
    }
    if (transitions.length) {
      console.log('\n── ข้อความที่จะส่ง ─────────────────────────────');
      console.log(buildMessage(transitions));
    }
  }

  console.log('\n── สรุป ────────────────────────────────────');
  if (problems.length === 0) {
    console.log('✅ พร้อมใช้งาน — ทดสอบ LINE ด้วย --test-line แล้วใส่ crontab ได้เลย');
    return 0;
  }
  console.log(`❌ ยังมีปัญหา ${problems.length} ข้อ: ${problems.join(', ')}`);
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// ดูข้อมูลใน refresh token: node quota-alert-line.js --token-info
//   ถ้า token เป็น JWT จะถอด claim ได้ (iss/sub/client_id/aud/exp/scope)
//   ถ้าเป็น opaque จะบอกได้แค่มูลฐาน (ใช้ --whoami แทนเพื่อดูตัวตนจริง)
// ─────────────────────────────────────────────────────────────────────────────

function tokenInfo() {
  const store = loadTokenStore();
  const token = store.refresh_token || cfg.refresh.token;
  if (!token) {
    console.log('❌ ยังไม่มี refresh token (ใช้ --set-refresh-token ก่อน)');
    return 1;
  }

  console.log(`ไฟล์: ${path.basename(cfg.refresh.tokenFile)}`);
  console.log(`ความยาว: ${token.length} ตัวอักษร | ขึ้นต้นด้วย: ${token.slice(0, 12)}...`);

  const parts = token.split('.');
  if (parts.length !== 3) {
    console.log('ℹ️  token ไม่ใช่ JWT (opaque) — อ่าน claim ไม่ได้');
    console.log('   ใช้ `--whoami` เพื่อดูว่า token แลกเป็น access token ของ user คนไหน');
    return 0;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const pick = ['iss', 'sub', 'client_id', 'aud', 'exp', 'iat', 'scope', 'jti'];
    console.log('\nclaims:');
    for (const key of pick) {
      if (payload[key] === undefined) continue;
      let value = payload[key];
      if (key === 'exp' || key === 'iat') {
        const d = new Date(value * 1000);
        value = `${d.toISOString()} (${Math.round((value * 1000 - Date.now()) / 1000)} วินาที)`;
      }
      if (Array.isArray(value)) value = value.join(', ');
      console.log(`  ${key.padEnd(10)} = ${value}`);
    }
    if (payload.iss) {
      console.log(`\n→ issuer ต้องตรงกับ LOGTO_ENDPOINT (${cfg.logto.endpoint || 'ยังไม่ได้ตั้ง'})`);
    }
    return 0;
  } catch (err) {
    console.log('⚠️  ถอด claim ไม่สำเร็จ:', err.message);
    return 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ลงทะเบียนรายงานเข้า DB: node quota-alert-line.js --register-report
//   ต้องมี DATABASE_URL (+ npm install pg) — ทางเลือกแทนการติดตั้ง psql
// ─────────────────────────────────────────────────────────────────────────────

async function registerReport() {
  if (!cfg.databaseUrl) throw new Error('ต้องตั้ง DATABASE_URL (postgres://user:pass@host:5432/db)');

  let pg;
  try {
    pg = require('pg');
  } catch {
    throw new Error('ต้องติดตั้งไดรเวอร์ก่อน: npm install pg');
  }

  const sqlFile = path.join(__dirname, 'register-report.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');

  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    log('กำลังรัน register-report.sql ...');
    await client.query(sql);

    const { rows } = await client.query(
      'select name, version, is_active, max_range_days from report_query where name = $1',
      [cfg.reportName],
    );
    if (rows.length === 0) {
      log('⚠️  ไม่พบแถวหลังลงทะเบียน — ตรวจว่า DB ที่ต่อคือ DB ที่ API ใช้');
    } else {
      const r = rows[0];
      log(`✅ ลงทะเบียนแล้ว: ${r.name} (version ${r.version}, active=${r.is_active})`);
    }

    // ถ้ามี API ให้ตรวจซ้ำว่ามองเห็นจากภายนอกด้วย
    if (cfg.apiBase) {
      const token = await getAccessToken().catch(() => null);
      if (token) {
        const catalog = await fetchJson(`${cfg.apiBase}/admin/reports/catalog`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        });
        const found = (catalog?.data || []).some((e) => e.name === cfg.reportName);
        log(found ? '✅ API มองเห็นรายงานนี้แล้ว' : '⚠️  API ยังไม่เห็นรายงาน (ตรวจว่า DB เดียวกันจริง)');
      }
    }
  } finally {
    await client.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ตั้ง refresh token ครั้งแรก: node quota-alert-line.js --set-refresh-token <token>
// ─────────────────────────────────────────────────────────────────────────────

async function setRefreshToken(token) {
  if (!token) throw new Error('ต้องระบุ token: --set-refresh-token <token>');
  saveTokenStore({ refresh_token: token.trim(), updated_at: new Date().toISOString() });
  log('บันทึก refresh token ลง', cfg.refresh.tokenFile, '(สิทธิ์ 600)');

  try {
    const access = await refreshAccessToken();
    log(`✅ แลก access token สำเร็จ (${access.length} ตัวอักษร) — พร้อมรัน cron`);
  } catch (err) {
    log('⚠️  แลก token ไม่สำเร็จ:', err.message);
    log('');
    log('ตรวจ 3 ข้อนี้:');
    log(`  1) คุณ login ที่ Backoffice ของ environment เดียวกับ API_BASE_URL (${cfg.apiBase || 'ยังไม่ได้ตั้ง'}) หรือไม่`);
    log('     token ของ Prod ใช้กับ Staging ไม่ได้ (คนละ app/client) แม้ Logto tenant เดียวกัน');
    log(`  2) client ที่ออก token ต้องเป็น ${cfg.logto.clientId || '(LOGTO_CLIENT_ID)'} (app ของ Backoffice env นี้)`);
    log('  3) token ต้องไม่ได้ถูกใช้ไปแล้ว — คัดลอกจากแท็บ incognito แล้ว "ปิดแท็บทันที"');
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CLI dispatch
//
// ⚠️ ห้ามใช้ process.exit() ตรง ๆ: บน Windows (libuv) ถ้ามี console write ค้างอยู่
//    จะเกิด "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" และ exit code เพี้ยน
//    -> ใช้ process.exitCode แล้วปล่อยให้ event loop ปิดเอง
// ─────────────────────────────────────────────────────────────────────────────

function finish(code) {
  process.exitCode = Number.isInteger(code) ? code : 1;
}

if (process.argv.includes('--selftest')) {
  selftest();
  finish(0);
} else if (process.argv.includes('--preview')) {
  preview();
  finish(0);
} else if (process.argv.includes('--register-report')) {
  registerReport()
    .then(() => finish(0))
    .catch((err) => {
      log('❌ ลงทะเบียนไม่สำเร็จ:', err.message);
      finish(1);
    });
} else if (process.argv.includes('--token-info')) {
  finish(tokenInfo());
} else if (process.argv.includes('--whoami')) {
  whoami()
    .then(() => finish(0))
    .catch((err) => {
      log('❌ ตรวจตัวตนไม่สำเร็จ:', err.message);
      finish(1);
    });
} else if (process.argv.indexOf('--set-refresh-token') !== -1) {
  const setIdx = process.argv.indexOf('--set-refresh-token');
  setRefreshToken(process.argv[setIdx + 1])
    .then(() => finish(process.exitCode || 0))
    .catch((err) => {
      log('❌ ไม่สำเร็จ:', err.message);
      finish(1);
    });
} else if (process.argv.includes('--check')) {
  check()
    .then((code) => finish(code))
    .catch((err) => {
      log('❌ ตรวจไม่สำเร็จ:', err.message);
      finish(1);
    });
} else if (process.argv.includes('--test-line')) {
  testLine()
    .then(() => finish(0))
    .catch((err) => {
      log('❌ ส่งไม่สำเร็จ:', err.message);
      finish(1);
    });
} else {
  main()
    .then((code) => finish(code))
    .catch((err) => {
      log('❌ ล้มเหลว:', err.message);
      if (cfg.verbose && err.stack) console.error(err.stack);
      finish(1);
    });
}
