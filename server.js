// 클라우드 펀딩 칩 투자 웹서비스 — 외부 패키지 없이 Node.js만으로 동작합니다.
// 실행: node server.js   (학생: http://주소:3000   교사용: http://주소:3000/teacher)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PIN = process.env.TEACHER_PIN || String(Math.floor(1000 + Math.random() * 9000));
const CHIPS = ['feasible', 'creative', 'social']; // 실현 가능성, 창의성, 사회 공헌
const MAX_STUDENTS = 300;
const MAX_GROUPS = 10;

// ---------- 상태 ----------
let state = { groupCount: 6, open: true, students: {}, log: [] };
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (saved && saved.students) state = { ...state, ...saved };
} catch (e) { /* 처음 실행이면 파일이 없습니다 */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(state), () => {});
  }, 500);
}

// ---------- 실시간(SSE) ----------
const studentClients = new Map(); // token -> Set(res)
const teacherClients = new Set();
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
let scheduled = false;
function scheduleBroadcast() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; broadcast(); }, 80);
}
function broadcast() {
  if (teacherClients.size) {
    const snap = teacherSnapshot();
    for (const res of teacherClients) sse(res, snap);
  }
  for (const [token, set] of studentClients) {
    const st = state.students[token];
    if (!st) continue;
    const me = studentView(st);
    for (const res of set) sse(res, me);
  }
}
setInterval(() => {
  for (const res of teacherClients) res.write(': ping\n\n');
  for (const set of studentClients.values()) for (const res of set) res.write(': ping\n\n');
}, 20000);

function isOnline(token) { const s = studentClients.get(token); return !!(s && s.size); }

// ---------- 보기 만들기 ----------
function studentView(st) {
  return { nick: st.nick, group: st.group, gave: st.gave, open: state.open, groupCount: state.groupCount };
}
function teacherSnapshot() {
  const groups = [];
  for (let g = 1; g <= state.groupCount; g++) {
    groups.push({ group: g, members: 0, feasible: 0, creative: 0, social: 0, total: 0 });
  }
  const students = [];
  let given = 0, finished = 0, online = 0;
  for (const [token, st] of Object.entries(state.students)) {
    if (groups[st.group - 1]) groups[st.group - 1].members++;
    let left = 0;
    for (const c of CHIPS) {
      const to = st.gave[c];
      if (to && groups[to - 1]) { groups[to - 1][c]++; groups[to - 1].total++; given++; } else left++;
    }
    if (left === 0) finished++;
    const on = isOnline(token);
    if (on) online++;
    students.push({ nick: st.nick, group: st.group, left, online: on });
  }
  students.sort((a, b) => a.group - b.group || a.nick.localeCompare(b.nick, 'ko'));
  return {
    open: state.open, groupCount: state.groupCount, groups, students,
    totals: { students: students.length, online, finished, given },
    log: state.log.slice(-30).reverse(),
  };
}

// ---------- 유틸 ----------
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4096) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const pinHash = crypto.createHash('sha256').update(PIN).digest();
const fails = new Map(); // ip -> {n, reset}
function clientIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function checkPin(req, url, res) {
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.reset > Date.now() && f.n >= 5) { sendJSON(res, 429, { error: '잠시 후 다시 시도해 주세요.' }); return false; }
  const p = req.headers['x-pin'] || url.searchParams.get('pin') || '';
  const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(String(p)).digest(), pinHash);
  if (!ok) {
    const cur = f && f.reset > Date.now() ? f : { n: 0, reset: Date.now() + 60000 };
    cur.n++; fails.set(ip, cur);
    sendJSON(res, 401, { error: 'PIN이 맞지 않아요.' });
    return false;
  }
  fails.delete(ip);
  return true;
}
function cleanNick(n) { return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 10); }
function findByNick(nick) {
  const key = nick.toLowerCase();
  return Object.entries(state.students).find(([, s]) => s.nick.toLowerCase() === key);
}
function addLog(entry) {
  state.log.push({ ts: Date.now(), ...entry });
  if (state.log.length > 100) state.log.splice(0, state.log.length - 100);
}
function dropStudent(token, notify) {
  const set = studentClients.get(token);
  if (set) { for (const r of set) { if (notify) sse(r, { removed: true }); r.end(); } studentClients.delete(token); }
  delete state.students[token];
}

// ---------- 라우팅 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // 화면
    if (req.method === 'GET' && (p === '/' || p === '/teacher')) {
      const file = path.join(__dirname, 'public', p === '/' ? 'index.html' : 'teacher.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    // 실시간 연결
    if (req.method === 'GET' && p === '/events') {
      const token = url.searchParams.get('token');
      const isTeacher = url.searchParams.has('pin');
      if (isTeacher) { if (!checkPin(req, url, res)) return; }
      else if (!state.students[token]) return sendJSON(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      if (isTeacher) {
        teacherClients.add(res);
        sse(res, teacherSnapshot());
        req.on('close', () => teacherClients.delete(res));
      } else {
        if (!studentClients.has(token)) studentClients.set(token, new Set());
        studentClients.get(token).add(res);
        sse(res, studentView(state.students[token]));
        scheduleBroadcast();
        req.on('close', () => {
          const set = studentClients.get(token);
          if (set) { set.delete(res); if (!set.size) studentClients.delete(token); }
          scheduleBroadcast();
        });
      }
      return;
    }

    // 학생 API
    if (req.method === 'GET' && p === '/api/config') {
      return sendJSON(res, 200, { groupCount: state.groupCount, open: state.open });
    }
    if (req.method === 'GET' && p === '/api/me') {
      const st = state.students[url.searchParams.get('token')];
      if (!st) return sendJSON(res, 404, { error: 'not found' });
      return sendJSON(res, 200, studentView(st));
    }
    if (req.method === 'POST' && p === '/api/join') {
      const b = await readBody(req);
      const nick = cleanNick(b.nick);
      const group = parseInt(b.group, 10);
      if (!nick) return sendJSON(res, 400, { error: '닉네임을 입력해 주세요.' });
      if (!(group >= 1 && group <= state.groupCount)) return sendJSON(res, 400, { error: '모둠을 골라 주세요.' });
      const hit = findByNick(nick);
      if (hit) {
        if (hit[1].group !== group) return sendJSON(res, 409, { error: '이미 쓰고 있는 닉네임이에요. 다른 닉네임을 써 주세요.' });
        return sendJSON(res, 200, { token: hit[0], me: studentView(hit[1]) });
      }
      if (Object.keys(state.students).length >= MAX_STUDENTS) return sendJSON(res, 503, { error: '입장 인원이 가득 찼어요.' });
      const token = crypto.randomBytes(12).toString('hex');
      state.students[token] = { nick, group, gave: { feasible: null, creative: null, social: null }, joinedAt: Date.now() };
      save(); scheduleBroadcast();
      return sendJSON(res, 200, { token, me: studentView(state.students[token]) });
    }
    if (req.method === 'POST' && (p === '/api/give' || p === '/api/undo')) {
      const b = await readBody(req);
      const st = state.students[b.token];
      if (!st) return sendJSON(res, 404, { error: '다시 입장해 주세요.' });
      if (!state.open) return sendJSON(res, 403, { error: '지금은 칩을 줄 수 없어요.' });
      if (!CHIPS.includes(b.chip)) return sendJSON(res, 400, { error: '칩 종류가 맞지 않아요.' });
      if (p === '/api/give') {
        const to = parseInt(b.group, 10);
        if (!(to >= 1 && to <= state.groupCount)) return sendJSON(res, 400, { error: '모둠을 골라 주세요.' });
        if (to === st.group) return sendJSON(res, 400, { error: '우리 모둠에는 칩을 줄 수 없어요.' });
        st.gave[b.chip] = to;
        addLog({ nick: st.nick, group: st.group, chip: b.chip, to });
      } else {
        st.gave[b.chip] = null;
        addLog({ nick: st.nick, group: st.group, chip: b.chip, to: null });
      }
      save(); scheduleBroadcast();
      return sendJSON(res, 200, studentView(st));
    }

    // 교사 API
    if (p.startsWith('/api/teacher/')) {
      if (!checkPin(req, url, res)) return;
      if (req.method === 'GET' && p === '/api/teacher/state') return sendJSON(res, 200, teacherSnapshot());
      if (req.method === 'POST' && p === '/api/teacher/config') {
        const b = await readBody(req);
        if (typeof b.open === 'boolean') state.open = b.open;
        if (b.groupCount !== undefined) {
          const n = parseInt(b.groupCount, 10);
          if (!(n >= 2 && n <= MAX_GROUPS)) return sendJSON(res, 400, { error: '모둠 수는 2~' + MAX_GROUPS + ' 사이로 정해 주세요.' });
          const used = Object.values(state.students).some((s) => s.group > n || CHIPS.some((c) => s.gave[c] > n));
          if (used) return sendJSON(res, 409, { error: n + '모둠보다 큰 모둠에 학생이나 칩이 있어서 줄일 수 없어요.' });
          state.groupCount = n;
        }
        save(); scheduleBroadcast();
        return sendJSON(res, 200, teacherSnapshot());
      }
      if (req.method === 'POST' && p === '/api/teacher/reset') {
        for (const token of Object.keys(state.students)) dropStudent(token, true);
        state.log = []; state.open = true;
        save(); scheduleBroadcast();
        return sendJSON(res, 200, teacherSnapshot());
      }
      if (req.method === 'POST' && p === '/api/teacher/remove') {
        const b = await readBody(req);
        const hit = findByNick(cleanNick(b.nick));
        if (hit) { dropStudent(hit[0], true); save(); scheduleBroadcast(); }
        return sendJSON(res, 200, teacherSnapshot());
      }
    }
    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 400, { error: '요청을 처리하지 못했어요.' });
  }
});

server.listen(PORT, () => {
  console.log('클라우드 펀딩 서버가 시작됐어요.');
  console.log('  학생 접속   : http://localhost:' + PORT + '/');
  console.log('  교사 대시보드: http://localhost:' + PORT + '/teacher');
  console.log('  교사 PIN    : ' + PIN + (process.env.TEACHER_PIN ? '' : '  (환경변수 TEACHER_PIN으로 직접 정할 수 있어요)'));
});
