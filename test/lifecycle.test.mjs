import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { configuredProject, git, REQUIREMENTS, DESIGN, TASK, APPROVE, tasksJson, testsJson, tempDir } from './helpers.mjs';
import { main } from '../engine/cli.mjs';
import { readJsonl } from '../engine/util.mjs';
import { runProcess, buildInvocation } from '../engine/process.mjs';
import { parseReview } from '../engine/review.mjs';
import { runBrowser } from '../engine/runners.mjs';

const F = ['--feature', 'FEAT-001'];
const CONFIRMED = ['--approval-text', '좋아 진행해', '--user-confirmed'];

function commitAll(p, message = 'init') {
  git(p.projectRoot, 'add', '-A');
  git(p.projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
}

function writeSource(p, rel, content = 'x') {
  const abs = path.join(p.projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function loadRun(p) {
  const dir = path.join(p.workflowRoot, 'runs');
  const [runId] = fs.readdirSync(dir);
  return JSON.parse(fs.readFileSync(path.join(dir, runId, 'run.json'), 'utf8'));
}

function eventTypes(p) {
  const run = loadRun(p);
  return readJsonl(path.join(p.workflowRoot, 'runs', run.runId, 'events.jsonl')).records.map((e) => e.type);
}

function reviewJson(verdict, { checks = { 'REQ-001': 'MET', 'REQ-002': 'MET' }, findings = [] } = {}) {
  return JSON.stringify({
    verdict,
    summary: verdict === 'APPROVED' ? '요구사항을 모두 충족한다.' : '빈 결과 처리가 빠졌다.',
    findings,
    requirementChecks: Object.entries(checks).map(([requirementId, status]) => ({ requirementId, status, evidence: 'src/pages/orders/List.tsx' })),
  });
}

function codexOutput(message) {
  return [
    JSON.stringify({ type: 'thread.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
}

// 셸 명령은 실제로 실행하고, codex 호출만 가짜 응답을 준다.
function fakeCodex(replies) {
  const calls = [];
  const fn = async (invocation) => {
    if (invocation.shell) return runProcess(invocation);
    calls.push(invocation);
    const reply = replies.shift();
    if (typeof reply === 'function') return reply(invocation);
    return { exitCode: 0, stdout: codexOutput(reply), stderr: '', timedOut: false, outputLimitExceeded: false };
  };
  fn.calls = calls;
  return fn;
}

async function project({ tests } = {}) {
  const p = await configuredProject();
  const extra = {};
  const run = async (...argv) => {
    const output = [];
    const code = await main(argv, { ...p.overrides, ...extra, out: (l) => output.push(l) });
    return { code, out: output.join('\n') };
  };
  await run('new', '--title', '주문 상태 필터');
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS);
  let r = await run('approve', ...F, '--phase', 'plan', ...APPROVE);
  assert.equal(r.code, 0, r.out);
  p.write('features/FEAT-001/design.md', DESIGN);
  p.write('features/FEAT-001/tasks.json', tasksJson([{ ...TASK, allowedFiles: ['src/pages/orders/**'] }]));
  p.write('features/FEAT-001/tests.json', testsJson(tests));
  r = await run('approve', ...F, '--phase', 'design', ...APPROVE);
  assert.equal(r.code, 0, r.out);
  commitAll(p);
  return { ...p, run, extra };
}

async function finishTask(p, file = 'src/pages/orders/List.tsx', content = 'list') {
  let r = await p.run('task-start', ...F, '--task', 'TASK-001');
  assert.equal(r.code, 0, r.out);
  writeSource(p, file, content);
  r = await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '목록 구현');
  assert.equal(r.code, 0, r.out);
}

function writeChecks(p, data) {
  const file = path.join(p.projectRoot, '..', `${path.basename(p.projectRoot)}-checks.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

test('설계 승인: tests.json 이 모든 REQ 를 필수 테스트로 덮어야 한다', async (t) => {
  const p = await configuredProject();
  t.after(p.cleanup);
  await p.run('new', '--title', '기능');
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS);
  await p.run('approve', ...F, '--phase', 'plan', ...APPROVE);
  p.write('features/FEAT-001/design.md', DESIGN);
  p.write('features/FEAT-001/tasks.json', tasksJson([TASK]));
  const attempt = async (tests) => {
    p.write('features/FEAT-001/tests.json', testsJson(tests));
    return p.run('approve', ...F, '--phase', 'design', ...APPROVE);
  };
  const base = { id: 'TEST-001', title: 't', kind: 'command', command: 'npm test', requirementIds: ['REQ-001'] };
  let r = await attempt([base]);
  assert.match(r.out, /REQUIREMENTS_UNTESTED.*REQ-002/);
  r = await attempt([base, { ...base, id: 'TEST-002', requirementIds: ['REQ-002'], required: false }]);
  assert.match(r.out, /REQUIREMENTS_UNTESTED.*REQ-002/, '선택 테스트는 커버리지가 아니다');
  r = await attempt([{ id: 'TEST-001', title: 'api', kind: 'http', requirementIds: ['REQ-001', 'REQ-002'], request: { origin: 'api', path: '/x' }, expect: { status: 200 } }]);
  assert.match(r.out, /TESTS_INVALID.*origins/);
  r = await attempt([{ ...base, requirementIds: ['REQ-001', 'REQ-002'], command: 'curl -H "Authorization: Bearer xoxb-1234567890-abcdef"' }]);
  assert.match(r.out, /TESTS_INVALID/);
  r = await attempt([{ id: 'TEST-001', title: 'b', kind: 'browser', origin: 'app', requirementIds: ['REQ-001', 'REQ-002'], steps: [{ action: 'click', selector: 'a' }] }]);
  assert.match(r.out, /TESTS_INVALID/);
  r = await attempt([{ ...base, requirementIds: ['REQ-001', 'REQ-002'] }]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /테스트 1개/);
  // tests.json 이 바뀌면 설계 승인이 풀린다.
  p.write('features/FEAT-001/tests.json', testsJson([{ ...base, requirementIds: ['REQ-001', 'REQ-002'], command: 'npm run test:all' }]));
  r = await p.run('status');
  assert.match(r.out, /TESTS_CHANGED/);
});

test('checks-set: 사용자 승인으로만 저장하고, 승인 뒤 바뀌면 검증을 막는다', async (t) => {
  const p = await project();
  t.after(p.cleanup);
  const from = writeChecks(p, { checks: [{ id: 'lint', title: '린트', command: 'node -e "process.exit(0)"' }] });
  let r = await p.run('checks-set', '--from', from);
  assert.equal(r.code, 2, '승인 문구 없이 저장하지 않는다');
  r = await p.run('checks-set', '--from', from, ...CONFIRMED);
  assert.equal(r.code, 0, r.out);
  const file = path.join(p.workflowRoot, 'checks.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.approval.approvalText, '좋아 진행해');
  r = await p.run('status');
  assert.match(r.out, /승인됨, 1개/);
  // 사람이든 세션이든 파일을 직접 고치면 승인이 풀린다.
  data.checks[0].command = 'exit 0';
  fs.writeFileSync(file, JSON.stringify(data));
  await finishTask(p);
  r = await p.run('verify', ...F);
  assert.match(r.out, /CHECKS_NOT_APPROVED/);
  r = await p.run('checks-set', ...CONFIRMED);
  assert.equal(r.code, 0, '현재 파일을 그대로 승인할 수 있다');
  r = await p.run('verify', ...F);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS\s+lint/);
});

test('전체 흐름: 검수 지적 → 다시 열기 → 검수 승인 → 검증 → 확정 → 문서 → 완료', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/orders?status=DONE') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ status: 'DONE' }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const p = await configuredProject();
  const from = writeChecks(p, { origins: { api: origin }, checks: [{ id: 'lint', title: '린트', command: 'node -e "process.exit(0)"' }] });
  assert.equal((await p.run('checks-set', '--from', from, ...CONFIRMED)).code, 0);
  t.after(p.cleanup);
  const extra = { runProcess: fakeCodex([]) };
  const run = async (...argv) => {
    const output = [];
    const code = await main(argv, { ...p.overrides, ...extra, out: (l) => output.push(l) });
    return { code, out: output.join('\n') };
  };
  await run('new', '--title', '주문 상태 필터');
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS);
  assert.equal((await run('approve', ...F, '--phase', 'plan', ...APPROVE)).code, 0);
  p.write('features/FEAT-001/design.md', DESIGN);
  p.write('features/FEAT-001/tasks.json', tasksJson([{ ...TASK, allowedFiles: ['src/pages/orders/**'] }]));
  p.write('features/FEAT-001/tests.json', testsJson([
    { id: 'TEST-001', title: '단위', kind: 'command', requirementIds: ['REQ-001'], command: 'node -e "process.exit(0)"' },
    { id: 'TEST-002', title: '상태 필터 API', kind: 'http', requirementIds: ['REQ-001'], request: { origin: 'api', path: '/api/orders?status=DONE' }, expect: { status: 200, contentType: 'application/json', json: [{ path: 'content.0.status', equals: 'DONE' }] } },
    { id: 'TEST-003', title: '조회 버튼', kind: 'manual', requirementIds: ['REQ-002'], steps: ['조회를 누른다'], expected: '목록이 바뀐다' },
  ]));
  let r = await run('approve', ...F, '--phase', 'design', ...APPROVE);
  assert.equal(r.code, 0, r.out);
  commitAll(p);

  r = await run('review', ...F);
  assert.match(r.out, /WRONG_PHASE/, '작업이 끝나기 전에는 검수하지 않는다');
  r = await run('task-start', ...F, '--task', 'TASK-001');
  writeSource(p, 'src/pages/orders/List.tsx', 'v1');
  r = await run('task-done', ...F, '--task', 'TASK-001', '--summary', '목록');
  assert.match(r.out, /검수/);
  assert.equal(loadRun(p).phase, 'REVIEW');

  // 1차 검수: 지적 → 다시 열어 고친다.
  extra.runProcess = fakeCodex([reviewJson('CHANGES_REQUESTED', { checks: { 'REQ-001': 'MET', 'REQ-002': 'NOT_MET' }, findings: [{ severity: 'high', file: 'src/pages/orders/List.tsx', line: 3, message: '빈 결과 처리 없음' }] })]);
  r = await run('review', ...F);
  assert.equal(r.code, 3);
  assert.match(r.out, /CHANGES_REQUESTED[\s\S]*\[high\] src\/pages\/orders\/List\.tsx:3 빈 결과 처리 없음/);
  const call = extra.runProcess.calls[0];
  assert.ok(call.args.includes('read-only') && call.args.includes('gpt-6.1-sol'), call.args.join(' '));
  const prompt = fs.readFileSync(path.join(p.workflowRoot, 'runs', loadRun(p).runId, 'reviews', 'R001-prompt.md'), 'utf8');
  assert.match(prompt, /List\.tsx \(새 파일\)\r?\nv1/, '프롬프트에 바뀐 내용이 들어간다');
  assert.match(prompt, /REQ-002/);
  r = await run('verify', ...F);
  assert.equal(r.code, 3, '검수 단계에서도 미리 검증은 돌릴 수 있다 (manual 대기라 미통과)');
  r = await run('confirm', ...F, ...CONFIRMED);
  assert.match(r.out, /WRONG_PHASE/);
  r = await run('task-reopen', ...F, '--task', 'TASK-001', '--reason', '검수 R001 빈 결과 처리');
  assert.equal(r.code, 0, r.out);
  assert.equal(loadRun(p).phase, 'DEVELOP');
  await run('task-start', ...F, '--task', 'TASK-001');
  writeSource(p, 'src/pages/orders/List.tsx', 'v2 empty state');
  r = await run('task-done', ...F, '--task', 'TASK-001', '--summary', '빈 결과 처리 추가');
  assert.equal(r.code, 0, r.out);

  // 2차 검수: 승인 → 검증 단계.
  extra.runProcess = fakeCodex([reviewJson('APPROVED')]);
  r = await run('review', ...F);
  assert.equal(r.code, 0, r.out);
  assert.equal(loadRun(p).phase, 'VERIFY');

  r = await run('verify', ...F);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /PASS\s+lint/);
  assert.match(r.out, /PASS\s+TEST-001/);
  assert.match(r.out, /PASS\s+TEST-002/);
  assert.match(r.out, /MANUAL\s+TEST-003/);
  r = await run('confirm', ...F, ...CONFIRMED);
  assert.match(r.out, /NOT_READY[\s\S]*TEST-003/);
  r = await run('test-confirm', ...F, '--test', 'TEST-003', '--approval-text', '눌러 보니 잘 바뀐다', '--user-confirmed');
  assert.equal(r.code, 0, r.out);
  r = await run('verify', ...F, '--only', 'TEST-003');
  assert.match(r.out, /일부/);
  r = await run('confirm', ...F, ...CONFIRMED);
  assert.match(r.out, /NOT_READY/, '일부 검증으로는 확정하지 않는다');
  r = await run('verify', ...F);
  assert.equal(r.code, 0, r.out);

  // 검증 뒤 코드가 바뀌면 확정할 수 없다.
  writeSource(p, 'src/pages/orders/List.tsx', 'v3 몰래 수정');
  r = await run('confirm', ...F, ...CONFIRMED);
  assert.match(r.out, /NOT_READY[\s\S]*검수 이후 코드가 바뀌었다[\s\S]*마지막 검증 이후 코드가 바뀌었다/);
  writeSource(p, 'src/pages/orders/List.tsx', 'v2 empty state');
  r = await run('confirm', ...F, ...CONFIRMED);
  assert.equal(r.code, 0, r.out);
  assert.equal(loadRun(p).phase, 'DOCS');

  // 문서 단계: 코드 수정은 막고, 문서가 있어야 끝난다.
  r = await run('docs-done', ...F, '--summary', '문서');
  assert.match(r.out, /DOCS_EMPTY/);
  writeSource(p, 'src/pages/orders/Other.tsx', 'late change');
  writeSource(p, 'docs/features/orders-filter.md', '# 주문 상태 필터');
  r = await run('docs-done', ...F, '--summary', '기능 문서 추가');
  assert.match(r.out, /OUT_OF_SCOPE[\s\S]*Other\.tsx/);
  fs.rmSync(path.join(p.projectRoot, 'src/pages/orders/Other.tsx'));
  r = await run('docs-done', ...F, '--summary', '기능 문서 추가');
  assert.equal(r.code, 0, r.out);
  const finalRun = loadRun(p);
  assert.equal(finalRun.phase, 'DONE');
  assert.deepEqual(finalRun.docs.files, ['docs/features/orders-filter.md']);
  const report = fs.readFileSync(path.join(p.featureDir(), 'report.md'), 'utf8');
  assert.match(report, /기능 보고서 — FEAT-001/);
  assert.match(report, /R002 APPROVED/);
  assert.match(report, /PASS TEST-002/);
  assert.match(report, /docs\/features\/orders-filter\.md/);
  assert.match(report, /src\/pages\/orders\/List\.tsx/);
  const types = eventTypes(p);
  for (const type of ['REVIEW_DONE', 'TASK_REOPENED', 'VERIFY_DONE', 'MANUAL_TEST_CONFIRMED', 'CONFIRMED', 'RUN_DONE']) assert.ok(types.includes(type), type);
  r = await run('status', '--all');
  assert.match(r.out, /완료[\s\S]*report\.md/);
});

test('review: 형식이 틀린 결과·파일 변경 시도는 막고, 사용자 허락으로 넘길 수 있다', async (t) => {
  const p = await project();
  t.after(p.cleanup);
  await finishTask(p);
  const attempts = [
    ['그냥 좋아 보입니다', /REVIEW_NOT_JSON/],
    [reviewJson('APPROVED', { checks: { 'REQ-001': 'MET', 'REQ-002': 'NOT_MET' } }), /REVIEW_INCONSISTENT/],
    [reviewJson('APPROVED', { checks: { 'REQ-001': 'MET' } }), /REVIEW_MISSING_REQUIREMENT.*REQ-002/],
    [() => ({ exitCode: 0, stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'file_change' } })}\n${codexOutput(reviewJson('APPROVED'))}`, stderr: '' }), /REVIEWER_ATTEMPTED_WRITE/],
    [() => ({ exitCode: null, stdout: '', stderr: '', spawnError: { code: 'ENOENT' } }), /CODEX_NOT_FOUND/],
  ];
  for (const [reply, expected] of attempts) {
    p.extra.runProcess = fakeCodex([reply]);
    const r = await p.run('review', ...F);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, expected);
  }
  assert.equal(loadRun(p).phase, 'REVIEW');
  assert.equal(eventTypes(p).filter((e) => e === 'REVIEW_FAILED').length, attempts.length);
  let r = await p.run('review-accept', ...F);
  assert.equal(r.code, 2);
  r = await p.run('review-accept', ...F, '--approval-text', 'codex 없이 진행해', '--user-confirmed');
  assert.equal(r.code, 0, r.out);
  const run = loadRun(p);
  assert.equal(run.phase, 'VERIFY');
  assert.equal(run.reviewOutcome.type, 'ACCEPTED');
});

test('parseReview: 코드 펜스 허용, 승인인데 high 지적이 있으면 거부', () => {
  const ok = parseReview(`\`\`\`json\n${reviewJson('APPROVED')}\n\`\`\``, ['REQ-001', 'REQ-002']);
  assert.ok(ok.ok);
  const bad = parseReview(reviewJson('APPROVED', { findings: [{ severity: 'high', message: 'x' }] }), ['REQ-001', 'REQ-002']);
  assert.equal(bad.code, 'REVIEW_INCONSISTENT');
});

test('Slack: 단계 이벤트만 실행별 스레드로 보내고, 실패는 상태를 바꾸지 않는다', async (t) => {
  const p = await configuredProject();
  t.after(p.cleanup);
  let r = await p.run('init', '--set', 'AIWF_SLACK_ENABLED=true', '--set', 'AIWF_SLACK_WORKSPACE=team.slack.com', '--set', 'AIWF_SLACK_USER_ID=U0123456789',
    '--set', 'AIWF_SLACK_CHANNEL_ID=D0123456789', '--set', `AIWF_SLACK_TOKEN_FILE=${path.join(p.projectRoot, 'token.dpapi')}`);
  assert.equal(r.code, 0, r.out);
  const sent = [];
  let ts = 0;
  const transport = async (invocation) => {
    const payload = JSON.parse(fs.readFileSync(invocation.args[invocation.args.indexOf('-PayloadFile') + 1], 'utf8'));
    assert.equal(invocation.args[invocation.args.indexOf('-Channel') + 1], 'D0123456789');
    sent.push(payload);
    ts += 1;
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, ts: `1700000000.00000${ts}` }), stderr: '' };
  };
  const run = async (overrides, ...argv) => {
    const output = [];
    const code = await main(argv, { ...p.overrides, platform: 'win32', runProcess: transport, ...overrides, out: (l) => output.push(l) });
    return { code, out: output.join('\n') };
  };
  r = await run({}, 'new', '--title', '알림 기능');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Slack 알림: 보냄 1/);
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS);
  r = await run({}, 'approve', ...F, '--phase', 'plan', ...APPROVE);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].threadTs, null);
  assert.equal(sent[1].threadTs, '1700000000.000001', '같은 실행은 첫 메시지의 스레드에 단다');
  assert.match(sent[0].text, /\[테스트 프로젝트\] RUN_CREATED — FEAT-001/);

  // 전송 실패: 설정 오류는 실패로 남고, 기능 상태는 그대로다.
  p.write('features/FEAT-001/requirements.md', `${REQUIREMENTS}- REQ-003: 추가\n`);
  const failing = async () => ({ exitCode: 2, stdout: JSON.stringify({ ok: false, configError: 'TOKEN_UNREADABLE' }), stderr: '' });
  r = await run({ runProcess: failing }, 'status');
  r = await run({ runProcess: failing }, 'approve', ...F, '--phase', 'plan', ...APPROVE);
  assert.match(r.out, /실패 1/);
  assert.equal(loadRun(p).phase, 'DESIGN');
  // 설정 오류가 나면 같은 이유로 실패할 나머지는 대기열에 남긴다.
  r = await run({}, 'notify');
  assert.match(r.out, /보냄 1/);
  assert.match(sent.at(-1).text, /REQUIREMENTS_CONFIRMED/);
  r = await run({}, 'notify');
  assert.match(r.out, /보냄 0/, '실패한 알림은 --retry-failed 없이 다시 보내지 않는다');
  r = await run({}, 'notify', '--retry-failed');
  assert.match(r.out, /보냄 1/);
  assert.match(sent.at(-1).text, /<@U0123456789>/, '되돌림 이벤트는 사용자를 멘션한다');

  // Windows 가 아니면 보내지 않고 이유를 남긴다.
  r = await run({ platform: 'linux' }, 'notify', '--test');
  assert.match(r.out, /UNSUPPORTED_PLATFORM/);
});

test('buildInvocation: Windows 의 .cmd CLI 는 cmd.exe 로 감싼다', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off');
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const inv = buildInvocation('codex', ['exec', '-C', 'C:\\my project', '-'], { env, platform: 'win32' });
    assert.equal(inv.command, env.ComSpec);
    assert.ok(inv.windowsVerbatimArguments);
    assert.match(inv.args.at(-1), /codex\.cmd exec -C "C:\\my project" -"$/i);
    assert.deepEqual(buildInvocation('codex', ['x'], { env, platform: 'linux' }), { command: 'codex', args: ['x'], windowsVerbatimArguments: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Playwright 를 흉내 내는 최소 가짜. 실제 브라우저 없이 실행기 흐름만 확인한다.
function fakePlaywright(dom) {
  const state = { url: 'about:blank', closed: false, filled: {} };
  const page = {
    setDefaultTimeout() {},
    async goto(url) { state.url = url; return { status: () => 200 }; },
    url: () => state.url,
    async screenshot() {},
    locator(selector) {
      const loc = {
        first: () => loc,
        async fill(v) { state.filled[selector] = v; },
        async click() { if (dom.clickNavigates?.[selector]) state.url = new URL(dom.clickNavigates[selector], state.url).href; },
        async press() {}, async selectOption() {}, async check() {},
        async waitFor({ state: want }) { if ((want === 'visible') !== !!dom.visible?.includes(selector)) throw new Error('timeout'); },
        async textContent() { return dom.text?.[selector] ?? null; },
        async count() { return dom.count?.[selector] ?? 0; },
      };
      return loc;
    },
  };
  return { state, chromium: { async launch() { return { async newContext() { return { newPage: async () => page }; }, async close() { state.closed = true; } }; } } };
}

test('browser 실행기: 선언형 단계 통과·실패와 정리', async () => {
  const io = { origins: { app: 'http://127.0.0.1:1' }, env: { AIWF_TEST_PASSWORD: 'p@ssw0rd!' }, projectRoot: process.cwd() };
  const steps = [
    { action: 'goto', path: '/login' },
    { action: 'expectVisible', selector: 'form' },
    { action: 'fill', selector: 'input[type=password]', valueFromEnv: 'AIWF_TEST_PASSWORD' },
    { action: 'click', selector: 'button' },
    { action: 'expectURL', path: '/home' },
    { action: 'expectText', selector: '.name', text: '님' },
    { action: 'expectCount', selector: '.row', count: 2 },
  ];
  const dom = { visible: ['form'], clickNavigates: { button: '/home' }, text: { '.name': '홍길동님' }, count: { '.row': 2 } };
  const pw = fakePlaywright(dom);
  let r = await runBrowser({ origin: 'app', steps }, { ...io, playwright: pw });
  assert.equal(r.status, 'PASS', r.log);
  assert.equal(pw.state.filled['input[type=password]'], 'p@ssw0rd!');
  assert.ok(pw.state.closed);
  const failing = fakePlaywright({ ...dom, text: { '.name': '손님 p@ssw0rd!' } });
  r = await runBrowser({ origin: 'app', steps: steps.map((s) => (s.action === 'expectText' ? { ...s, text: '홍길동' } : s)) }, { ...io, playwright: failing });
  assert.equal(r.status, 'FAIL');
  assert.match(r.message, /expectText/);
  assert.doesNotMatch(r.message + r.log, /p@ssw0rd!/, '비밀값은 로그에 남기지 않는다');
  assert.ok(failing.state.closed);
  r = await runBrowser({ origin: 'app', steps: [{ action: 'goto', path: '/' }, { action: 'fill', selector: 'x', valueFromEnv: 'AIWF_TEST_MISSING' }, { action: 'expectVisible', selector: 'x' }] }, { ...io, playwright: fakePlaywright({}) });
  assert.equal(r.code, 'ENV_MISSING');
  r = await runBrowser({ origin: 'app', steps }, { ...io, playwright: { error: 'Playwright 없음' } });
  assert.equal(r.code, 'PLAYWRIGHT_MISSING');
});
