#!/usr/bin/env node
// 장애·확장 실험 중 서비스 상태를 1초마다 관찰한다. (내 PC에서 실행)
//
//   node scripts/watch.mjs http://본인-Public-ALB-DNS
//   node scripts/watch.mjs http://본인-Public-ALB-DNS | tee watch.log
//
// 시작할 때 한 번만 로그인하고 같은 쿠키를 계속 쓴다.
// 세션 유지 실험 중에는 이 스크립트를 재시작하지 않는다. (재시작하면 새로 로그인한다)
//
// 출력 예:
//   17:31:11  me 200 test01  i-0abc... ap-northeast-2c  web i-0def... ap-northeast-2a  courses 200 14ms

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) ?? '').replace(/\/+$/, '');
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (!/^https?:\/\//.test(base)) {
  console.error('사용법: node scripts/watch.mjs http://본인-Public-ALB-DNS [--user=test01] [--password=asbg1234] [--interval=1000]');
  process.exit(1);
}

const USER = option('user', 'test01');
const PASSWORD = option('password', 'asbg1234');
const INTERVAL = Number(option('interval', '1000'));
const TIMEOUT = 3000;

let cookie = '';

const clock = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

function keepCookie(res) {
  const set = res.headers.getSetCookie?.() ?? [];
  const sid = set.find((c) => c.startsWith('portal.sid='));
  if (sid) cookie = sid.split(';')[0];
}

async function call(path, init = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    keepCookie(res);
    let body = null;
    try { body = await res.json(); } catch { /* ALB 502 등은 JSON이 아니다 */ }
    return {
      status: res.status,
      body,
      web: res.headers.get('x-web-instance') ?? '-',
      app: res.headers.get('x-app-instance') ?? '-',
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return { status: timeout ? 'timeout' : 'error', error: err.cause?.code ?? err.message, ms: Math.round(performance.now() - started) };
  }
}

async function login() {
  const r = await call('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (r.status !== 200 || !cookie) {
    console.error(`로그인 실패: ${r.status} ${r.body?.message ?? r.error ?? ''}`);
    process.exit(1);
  }
  console.log(`${clock()}  로그인 ${USER}  처리 APP ${r.app}  (이 쿠키로 계속 관찰합니다. Ctrl+C로 종료)`);
}

function line(t, me, courses) {
  const parts = [t];
  if (me.status === 200) {
    parts.push(`me 200 ${me.body?.user?.username ?? '?'}`, `${me.body?.server?.instance ?? '?'} ${me.body?.server?.az ?? ''}`);
  } else {
    parts.push(`me ${me.status}${me.body?.error ? ` ${me.body.error}` : me.error ? ` ${me.error}` : ''}`);
  }
  if (me.web && me.web !== '-') parts.push(`web ${me.web}`);
  parts.push(
    courses.status === 200
      ? `courses 200 ${courses.ms}ms`
      : `courses ${courses.status}${courses.error ? ` ${courses.error}` : ''}`,
  );
  return parts.join('  ');
}

await login();

let stopped = false;
process.on('SIGINT', () => { stopped = true; console.log('\n종료'); process.exit(0); });

// 느린 요청을 기다리지 않고 1초 간격을 유지한다. (응답이 늦으면 출력 순서가 일부 뒤섞일 수 있다)
while (!stopped) {
  const t = clock();
  Promise.all([call('/api/me'), call('/api/courses')]).then(([me, courses]) => {
    console.log(line(t, me, courses));
  });
  await new Promise((r) => setTimeout(r, INTERVAL));
}
