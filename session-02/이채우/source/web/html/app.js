'use strict';

const $ = (sel) => document.querySelector(sel);
let toastTimer;
let enrolledIds = new Set();

function showToast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// 응답 헤더로 어떤 WEB과 APP이 처리했는지 표시한다.
function updateServers(headers) {
  const web = headers.get('X-Web-Instance');
  const app = headers.get('X-App-Instance');
  if (web) $('#web-server').textContent = web;
  if (app) $('#app-server').textContent = app;
  $('#served-at').textContent = new Date().toLocaleTimeString('ko-KR');
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  updateServers(res.headers);
  let data = null;
  try { data = await res.json(); } catch { /* 본문이 JSON이 아닐 수 있다 (예: ALB 502) */ }
  if (!res.ok) {
    const err = new Error(data?.message ?? `요청 실패 (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function showLogin() {
  $('#login-view').hidden = false;
  $('#main-view').hidden = true;
  $('#user-area').hidden = true;
  $('#username').focus();
}

function showMain(user) {
  $('#login-view').hidden = true;
  $('#main-view').hidden = false;
  $('#user-area').hidden = false;
  $('#user-name').textContent = `${user.name} (${user.username})`;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderEnrollments(data) {
  enrolledIds = new Set(data.items.map((c) => c.id));
  $('#summary-text').textContent =
    `${data.count}과목 · ${data.totalCredits}학점 신청 (최대 ${data.maxCredits}학점)`;
  const list = $('#my-list');
  list.replaceChildren();
  if (data.items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 신청한 과목이 없습니다.';
    list.append(li);
    return;
  }
  for (const c of data.items) {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = c.title;
    const meta = document.createElement('span');
    meta.textContent = `${c.code} · ${c.professor} · ${c.schedule} · ${c.credits}학점`;
    li.append(title, meta);
    list.append(li);
  }
}

function renderCourses(courses) {
  const tbody = $('#course-rows');
  tbody.replaceChildren();
  for (const c of courses) {
    const tr = document.createElement('tr');
    const mine = enrolledIds.has(c.id);
    const full = c.enrolled >= c.capacity;
    tr.append(
      cell(c.code, 'mono'),
      cell(c.title),
      cell(c.professor),
      cell(c.schedule),
      cell(String(c.credits), 'num'),
      cell(`${c.enrolled}/${c.capacity}`, full ? 'num full' : 'num'),
    );
    const action = document.createElement('td');
    action.className = 'action';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = mine ? 'btn ghost small' : 'btn primary small';
    btn.textContent = mine ? '취소' : full ? '마감' : '신청';
    btn.disabled = !mine && full;
    btn.addEventListener('click', () => (mine ? cancel(c) : enroll(c)));
    action.append(btn);
    tr.append(action);
    tbody.append(tr);
  }
}

async function loadAll() {
  const [enrollments, courses] = await Promise.all([api('/enrollments'), api('/courses')]);
  renderEnrollments(enrollments);
  renderCourses(courses.courses);
}

async function enroll(course) {
  try {
    renderEnrollments(await api('/enrollments', { method: 'POST', body: { courseId: course.id } }));
    showToast(`${course.title} 신청 완료`);
  } catch (err) {
    if (err.status === 401) return showLogin();
    showToast(err.message, true);
  }
  await loadAll().catch(() => {});
}

async function cancel(course) {
  try {
    renderEnrollments(await api(`/enrollments/${course.id}`, { method: 'DELETE' }));
    showToast(`${course.title} 신청 취소`);
  } catch (err) {
    if (err.status === 401) return showLogin();
    showToast(err.message, true);
  }
  await loadAll().catch(() => {});
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/login', {
      method: 'POST',
      body: { username: $('#username').value.trim(), password: $('#password').value },
    });
    $('#password').value = '';
    showMain(data.user);
    await loadAll();
  } catch (err) {
    showToast(err.message, true);
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch { /* 이미 끊긴 세션이어도 화면은 로그인으로 */ }
  showLogin();
});

$('#refresh-btn').addEventListener('click', async () => {
  try {
    const me = await api('/me');
    showMain(me.user);
    await loadAll();
  } catch (err) {
    if (err.status === 401) return showLogin();
    showToast(err.message, true);
  }
});

(async () => {
  try {
    const me = await api('/me');
    showMain(me.user);
    await loadAll();
  } catch (err) {
    if (err.status !== 401) showToast(err.message, true);
    showLogin();
  }
})();
