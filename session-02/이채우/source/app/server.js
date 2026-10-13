// 수강신청 포털 APP 계층
// - 포트 8080, /health 는 프로세스 상태만 확인 (DB·캐시 조회 없음)
// - 로그인 세션은 ElastiCache(Valkey)에 저장해 모든 APP이 공유
// - 사용자·강좌·신청 내역은 RDS MySQL에 저장
// - DB 비밀번호와 세션 서명 키는 EC2 역할로 Secrets Manager에서 읽음

import os from 'node:os';
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import express from 'express';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import mysql from 'mysql2/promise';
import awsCaBundle from 'aws-ssl-profiles';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const scrypt = promisify(scryptCb);

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 ${name} 이(가) 비어 있습니다`);
  return value;
}

const config = {
  port: Number(process.env.PORT ?? 8080),
  region: process.env.AWS_REGION ?? 'ap-northeast-2',
  dbHost: required('DB_HOST'),
  dbPort: Number(process.env.DB_PORT ?? 3306),
  dbName: process.env.DB_NAME ?? 'portal',
  dbSecretId: process.env.DB_SECRET_ID,
  sessionSecretId: process.env.SESSION_SECRET_ID,
  redisUrl: required('REDIS_URL'),
  // 아래 세 값은 로컬 테스트용이다. EC2에서는 비워 두고 Secrets Manager를 사용한다.
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  dbTls: (process.env.DB_TLS ?? 'on') !== 'off',
};

const MAX_CREDITS = 18;
const QUERY_TIMEOUT_MS = 5000;
const TEST_PASSWORD = 'asbg1234';

if (!/^[A-Za-z0-9_]+$/.test(config.dbName)) {
  throw new Error('DB_NAME 은 영문, 숫자, _ 만 사용할 수 있습니다');
}

// ---------------------------------------------------------------------------
// 공통 도구
// ---------------------------------------------------------------------------

function log(...args) {
  console.log('[portal-app]', ...args);
}

// 같은 오류가 반복될 때 로그가 넘치지 않도록 5초에 한 번만 남긴다.
function throttled(intervalMs, fn) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      fn(...args);
    }
  };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// 시작 준비: 인스턴스 정보, 보안 암호
// ---------------------------------------------------------------------------

// IMDSv2로 자기 인스턴스 ID와 AZ를 읽는다. EC2가 아니면 호스트 이름을 쓴다.
async function loadIdentity() {
  const base = 'http://169.254.169.254/latest';
  try {
    const tokenRes = await fetch(`${base}/api/token`, {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(1000),
    });
    if (!tokenRes.ok) throw new Error(`IMDS token ${tokenRes.status}`);
    const token = await tokenRes.text();
    const get = async (path) => {
      const res = await fetch(`${base}/meta-data/${path}`, {
        headers: { 'X-aws-ec2-metadata-token': token },
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) throw new Error(`IMDS ${path} ${res.status}`);
      return res.text();
    };
    const [instanceId, az] = await Promise.all([get('instance-id'), get('placement/availability-zone')]);
    return { instance: instanceId, az };
  } catch {
    return { instance: os.hostname(), az: 'local' };
  }
}

async function readSecret(client, secretId) {
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const raw = out.SecretString ?? '';
  try {
    return JSON.parse(raw);
  } catch {
    return { value: raw };
  }
}

async function loadSecrets() {
  let sm;
  const secrets = () => (sm ??= new SecretsManagerClient({ region: config.region }));

  let dbUser = config.dbUser;
  let dbPassword = config.dbPassword;
  if (!dbUser || !dbPassword) {
    if (!config.dbSecretId) throw new Error('DB_SECRET_ID 가 필요합니다');
    const s = await readSecret(secrets(), config.dbSecretId);
    dbUser = s.username;
    dbPassword = s.password;
    if (!dbUser || !dbPassword) throw new Error('DB 보안 암호에 username/password 가 없습니다');
  }

  let sessionSecret = config.sessionSecret;
  if (!sessionSecret) {
    if (!config.sessionSecretId) throw new Error('SESSION_SECRET_ID 가 필요합니다');
    const s = await readSecret(secrets(), config.sessionSecretId);
    sessionSecret = s.secret ?? s.value;
    if (!sessionSecret) throw new Error('세션 보안 암호에 secret 값이 없습니다');
  }

  return { dbUser, dbPassword, sessionSecret };
}

// ---------------------------------------------------------------------------
// DB 준비: 데이터베이스, 표, 테스트 데이터
// ---------------------------------------------------------------------------

const SEED_COURSES = [
  ['CS201', '자료구조', '김하늘', 3, 30, '월 수 10:30'],
  ['CS202', '컴퓨터구조', '이도윤', 3, 30, '화 목 09:00'],
  ['CS301', '운영체제', '박서진', 3, 25, '월 수 13:30'],
  ['CS302', '데이터베이스', '최유나', 3, 25, '화 목 13:30'],
  ['CS303', '컴퓨터네트워크', '정민호', 3, 25, '수 금 10:30'],
  ['CS304', '알고리즘', '한지우', 3, 30, '월 수 15:00'],
  ['CS401', '클라우드컴퓨팅', '오세린', 3, 20, '목 15:00'],
  ['CS402', '소프트웨어공학', '윤태경', 3, 20, '금 13:00'],
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     username VARCHAR(32) NOT NULL UNIQUE,
     name VARCHAR(50) NOT NULL,
     password_hash VARCHAR(255) NOT NULL,
     created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS courses (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     code VARCHAR(16) NOT NULL UNIQUE,
     title VARCHAR(100) NOT NULL,
     professor VARCHAR(50) NOT NULL,
     credits TINYINT UNSIGNED NOT NULL,
     capacity INT UNSIGNED NOT NULL,
     enrolled INT UNSIGNED NOT NULL DEFAULT 0,
     schedule VARCHAR(50) NOT NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS enrollments (
     user_id INT UNSIGNED NOT NULL,
     course_id INT UNSIGNED NOT NULL,
     created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (user_id, course_id),
     KEY idx_enrollments_course (course_id),
     CONSTRAINT fk_enrollments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
     CONSTRAINT fk_enrollments_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
   ) ENGINE=InnoDB`,
];

async function initDatabase({ dbUser, dbPassword }) {
  const base = {
    host: config.dbHost,
    port: config.dbPort,
    user: dbUser,
    password: dbPassword,
    charset: 'utf8mb4',
    connectTimeout: 5000,
    enableKeepAlive: true,
    // RDS 인증서를 검증하는 TLS 연결. 로컬 테스트에서만 DB_TLS=off 로 끈다.
    ssl: config.dbTls ? awsCaBundle : undefined,
  };

  const admin = await mysql.createConnection(base);
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end();
  }

  const pool = mysql.createPool({
    ...base,
    database: config.dbName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 200,
  });

  // APP 여러 대가 동시에 시작해도 초기화가 겹치지 않도록 DB 잠금을 건다.
  const conn = await pool.getConnection();
  try {
    const [[{ locked }]] = await conn.query("SELECT GET_LOCK('portal_init', 60) AS locked");
    if (locked !== 1) throw new Error('초기화 잠금을 얻지 못했습니다');
    try {
      for (const ddl of SCHEMA) await conn.query(ddl);

      await conn.query(
        'INSERT IGNORE INTO courses (code, title, professor, credits, capacity, schedule) VALUES ?',
        [SEED_COURSES],
      );

      const [existing] = await conn.query('SELECT username FROM users');
      const have = new Set(existing.map((r) => r.username));
      const rows = [];
      for (let i = 1; i <= 30; i++) {
        const username = `test${String(i).padStart(2, '0')}`;
        if (!have.has(username)) {
          rows.push([username, `테스트${String(i).padStart(2, '0')}`, await hashPassword(TEST_PASSWORD)]);
        }
      }
      if (rows.length > 0) {
        await conn.query('INSERT IGNORE INTO users (username, name, password_hash) VALUES ?', [rows]);
        log(`테스트 계정 ${rows.length}개 생성`);
      }
    } finally {
      await conn.query("SELECT RELEASE_LOCK('portal_init')");
    }
  } finally {
    conn.release();
  }

  return pool;
}

// ---------------------------------------------------------------------------
// 캐시 준비
// ---------------------------------------------------------------------------

async function initRedis() {
  const client = createClient({
    url: config.redisUrl, // rediss:// 이면 TLS로 연결한다
    disableClientInfo: true,
    disableOfflineQueue: true, // 끊긴 동안 요청을 쌓아 두지 않고 바로 실패시킨다
    pingInterval: 30_000,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(200 * (retries + 1), 3000),
    },
  });
  const logError = throttled(5000, (err) => log('캐시 연결 오류:', err.message));
  client.on('error', logError);
  client.on('reconnecting', throttled(5000, () => log('캐시 재연결 시도 중')));
  await client.connect();
  return client;
}

// ---------------------------------------------------------------------------
// HTTP 서버
// ---------------------------------------------------------------------------

function buildApp({ pool, redis, sessionSecret, identity }) {
  const serverLabel = `${identity.instance} ${identity.az}`;
  const server = { instance: identity.instance, az: identity.az };
  const q = (conn, sql, params) => conn.query({ sql, timeout: QUERY_TIMEOUT_MS }, params);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.set('X-App-Instance', serverLabel);
    next();
  });

  // ALB 상태 검사용. DB나 캐시 문제로 모든 APP이 한꺼번에 교체되지 않도록 프로세스만 확인한다.
  app.get('/health', (req, res) => {
    res.type('text/plain').send('ok');
  });

  const api = express.Router();
  api.use(express.json({ limit: '10kb' }));
  api.use(
    session({
      name: 'portal.sid',
      store: new RedisStore({ client: redis, prefix: 'portal:sess:' }),
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // HTTP로 실습한다. HTTPS를 붙이면 true로 바꾼다.
        maxAge: 2 * 60 * 60 * 1000,
      },
    }),
  );

  const requireLogin = (req, res, next) => {
    if (!req.session?.userId) return next(new HttpError(401, 'login_required', '로그인이 필요합니다'));
    next();
  };

  const currentUser = (req) => ({ username: req.session.username, name: req.session.name });

  async function myEnrollments(userId) {
    const [rows] = await q(
      pool,
      `SELECT c.id, c.code, c.title, c.professor, c.credits, c.schedule, e.created_at AS enrolledAt
         FROM enrollments e JOIN courses c ON c.id = e.course_id
        WHERE e.user_id = ? ORDER BY c.code`,
      [userId],
    );
    const totalCredits = rows.reduce((sum, r) => sum + r.credits, 0);
    return { items: rows, count: rows.length, totalCredits, maxCredits: MAX_CREDITS };
  }

  api.post('/login', async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password) throw new HttpError(400, 'invalid_input', '아이디와 비밀번호를 입력하세요');

    const [[user]] = await q(pool, 'SELECT id, username, name, password_hash FROM users WHERE username = ?', [
      username,
    ]);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, 'invalid_credentials', '아이디 또는 비밀번호가 올바르지 않습니다');
    }

    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.name = user.name;
    req.session.loginAt = new Date().toISOString();
    req.session.loginServer = serverLabel;
    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));

    res.json({ user: currentUser(req), server });
  });

  api.post('/logout', async (req, res) => {
    if (req.session) {
      await new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
    }
    res.clearCookie('portal.sid');
    res.json({ ok: true, server });
  });

  api.get('/me', requireLogin, (req, res) => {
    res.json({
      user: currentUser(req),
      loginAt: req.session.loginAt,
      loginServer: req.session.loginServer,
      server,
    });
  });

  // 강좌 목록은 로그인 없이 조회할 수 있다. 부하 시험(hey)도 이 경로를 사용한다.
  api.get('/courses', async (req, res) => {
    const [rows] = await q(
      pool,
      'SELECT id, code, title, professor, credits, capacity, enrolled, schedule FROM courses ORDER BY code',
    );
    res.json({ courses: rows, server });
  });

  api.get('/enrollments', requireLogin, async (req, res) => {
    res.json({ ...(await myEnrollments(req.session.userId)), server });
  });

  api.post('/enrollments', requireLogin, async (req, res) => {
    const courseId = Number(req.body?.courseId);
    if (!Number.isInteger(courseId) || courseId <= 0) throw new HttpError(400, 'invalid_input', '강좌를 선택하세요');
    const userId = req.session.userId;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // 같은 강좌에 동시에 신청이 몰려도 정원을 넘지 않도록 강좌 행을 잠근다.
      const [[course]] = await q(
        conn,
        'SELECT id, title, credits, capacity, enrolled FROM courses WHERE id = ? FOR UPDATE',
        [courseId],
      );
      if (!course) throw new HttpError(404, 'course_not_found', '없는 강좌입니다');

      const [[dup]] = await q(conn, 'SELECT 1 AS yes FROM enrollments WHERE user_id = ? AND course_id = ?', [
        userId,
        courseId,
      ]);
      if (dup) throw new HttpError(409, 'already_enrolled', '이미 신청한 강좌입니다');

      const [[{ total }]] = await q(
        conn,
        `SELECT COALESCE(SUM(c.credits), 0) AS total
           FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = ?`,
        [userId],
      );
      if (Number(total) + course.credits > MAX_CREDITS) {
        throw new HttpError(409, 'credit_limit', `최대 ${MAX_CREDITS}학점까지 신청할 수 있습니다`);
      }
      if (course.enrolled >= course.capacity) throw new HttpError(409, 'course_full', '정원이 가득 찼습니다');

      await q(conn, 'INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)', [userId, courseId]);
      await q(conn, 'UPDATE courses SET enrolled = enrolled + 1 WHERE id = ?', [courseId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }

    res.status(201).json({ ...(await myEnrollments(userId)), server });
  });

  api.delete('/enrollments/:courseId', requireLogin, async (req, res) => {
    const courseId = Number(req.params.courseId);
    if (!Number.isInteger(courseId) || courseId <= 0) throw new HttpError(400, 'invalid_input', '강좌를 선택하세요');
    const userId = req.session.userId;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await q(conn, 'SELECT id FROM courses WHERE id = ? FOR UPDATE', [courseId]);
      const [result] = await q(conn, 'DELETE FROM enrollments WHERE user_id = ? AND course_id = ?', [
        userId,
        courseId,
      ]);
      if (result.affectedRows === 0) throw new HttpError(404, 'not_enrolled', '신청하지 않은 강좌입니다');
      await q(conn, 'UPDATE courses SET enrolled = enrolled - 1 WHERE id = ? AND enrolled > 0', [courseId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }

    res.json({ ...(await myEnrollments(userId)), server });
  });

  api.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: '없는 API입니다', server });
  });

  app.use('/api', api);

  app.use((req, res) => {
    res.status(404).type('text/plain').send('not found');
  });

  const DB_DOWN = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_SEQUENCE_TIMEOUT',
    'ER_CON_COUNT_ERROR',
    'POOL_ENQUEUELIMIT',
  ]);
  const logServerError = throttled(1000, (req, err) => log(`오류 ${req.method} ${req.originalUrl}:`, err.code ?? '', err.message));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message, server });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: '요청 형식이 올바르지 않습니다', server });
    }
    logServerError(req, err);
    if (DB_DOWN.has(err.code) || /connect|closed|offline|timeout/i.test(err.message ?? '')) {
      return res.status(503).json({ error: 'service_unavailable', message: '잠시 후 다시 시도하세요', server });
    }
    res.status(500).json({ error: 'server_error', message: '서버 오류가 발생했습니다', server });
  });

  return app;
}

// ---------------------------------------------------------------------------
// 시작과 종료
// ---------------------------------------------------------------------------

async function main() {
  const identity = await loadIdentity();
  log(`시작 (${identity.instance} ${identity.az})`);

  const secrets = await loadSecrets();
  const pool = await initDatabase(secrets);
  log('DB 연결 완료');
  const redis = await initRedis();
  log('캐시 연결 완료');

  const app = buildApp({ pool, redis, sessionSecret: secrets.sessionSecret, identity });
  const server = app.listen(config.port, () => {
    log(`portal-app listening on ${config.port} (${identity.instance} ${identity.az})`);
  });
  server.keepAliveTimeout = 65_000; // ALB 유휴 제한 시간(60초)보다 길게
  server.headersTimeout = 66_000;

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} 수신, 종료 중`);
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    server.close(async () => {
      await Promise.allSettled([redis.quit(), pool.end()]);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log('시작 실패:', err.message);
  process.exit(1);
});
