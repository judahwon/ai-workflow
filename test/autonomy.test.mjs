import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredProject, git, REQUIREMENTS, DESIGN, TASK, APPROVE, tasksJson, testsJson } from './helpers.mjs';
import { main } from '../engine/cli.mjs';
import { readJsonl } from '../engine/util.mjs';
import { runProcess } from '../engine/process.mjs';
import { hasShellChaining } from '../engine/autonomy.mjs';
import { runSessionHook } from '../engine/session-hook.mjs';
import { formatAlert } from '../engine/alerts.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = `node "${path.join(ROOT, 'engine', 'cli.mjs')}"`;
const F = ['--feature', 'FEAT-001'];
const CONFIRMED = ['--approval-text', '좋아 진행해', '--user-confirmed'];
const SLACK = { AIWF_PROJECT_NAME: '테스트 프로젝트', AIWF_DOC_LANGUAGE: 'ko', AIWF_SLACK_USER_ID: 'U0123456789' };

function codexReply(message) {
  return [
    JSON.stringify({ type: 'thread.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
}

function reviewJson(verdict, findings = []) {
  return JSON.stringify({
    verdict,
    summary: verdict === 'APPROVED' ? '충족한다.' : '빈 결과 처리가 빠졌다.',
    findings,
    requirementChecks: ['REQ-001', 'REQ-002'].map((requirementId) => ({ requirementId, status: verdict === 'APPROVED' ? 'MET' : 'NOT_MET', evidence: 'src/pages/orders/List.tsx' })),
  });
}

// 셸 명령은 실제로 실행하고, codex 만 가짜 응답을 준다.
function fakeCodex(replies) {
  return async (invocation) => {
    if (invocation.shell) return runProcess(invocation);
    const text = invocation.windowsVerbatimArguments ? invocation.args.at(-1) : invocation.args.join(' ');
    if (/login status/.test(text)) return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false, outputLimitExceeded: false };
    return { exitCode: 0, stdout: codexReply(replies.shift()), stderr: '', timedOut: false, outputLimitExceeded: false };
  };
}

const FINDING = [{ severity: 'high', file: 'src/pages/orders/List.tsx', line: 1, message: '빈 결과 처리 없음' }];

async function autonomousProject({ autonomous = true } = {}) {
  const p = await configuredProject();
  const extra = {};
  const run = async (...argv) => {
    const output = [];
    const code = await main(argv, { ...p.overrides, ...extra, out: (l) => output.push(l) });
    return { code, out: output.join('\n') };
  };
  await run('init', '--set', 'AIWF_AUTO_MAX_REVIEW_ROUNDS=2');
  const checks = path.join(p.projectRoot, '..', `${path.basename(p.projectRoot)}-checks.json`);
  fs.writeFileSync(checks, JSON.stringify({ origins: {}, checks: [{ id: 'lint', title: '린트', command: 'node -e "process.exit(0)"' }] }));
  assert.equal((await run('checks-set', '--from', checks, ...CONFIRMED)).code, 0);
  await run('new', '--title', '주문 상태 필터');
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS);
  const r = await run('approve', ...F, '--phase', 'plan', ...APPROVE, ...(autonomous ? ['--autonomous'] : []));
  assert.equal(r.code, 0, r.out);
  p.write('features/FEAT-001/design.md', DESIGN);
  p.write('features/FEAT-001/tasks.json', tasksJson([{ ...TASK, allowedFiles: ['src/pages/orders/**'] }]));
  p.write('features/FEAT-001/tests.json', testsJson([
    { id: 'TEST-001', title: '단위', kind: 'command', requirementIds: ['REQ-001', 'REQ-002'], command: 'node -e "process.exit(0)"' },
  ]));
  const loadRun = () => {
    const dir = path.join(p.workflowRoot, 'runs');
    const [runId] = fs.readdirSync(dir);
    return JSON.parse(fs.readFileSync(path.join(dir, runId, 'run.json'), 'utf8'));
  };
  const events = () => readJsonl(path.join(p.workflowRoot, 'runs', loadRun().runId, 'events.jsonl')).records;
  const hook = (event, input) => runSessionHook(event, JSON.stringify(input), p.overrides);
  return { ...p, run, extra, loadRun, events, hook, firstOut: r.out };
}

test('셸 연결 문자: 따옴표 밖만 본다', () => {
  assert.equal(hasShellChaining('npm test'), false);
  assert.equal(hasShellChaining('node -e "a && b; c | d"'), false);
  for (const bad of ['npm test && rm -rf x', 'npm test; ls', 'npm test | tee', 'npm test > out', 'echo $(whoami)', 'echo `id`']) assert.ok(hasShellChaining(bad), bad);
});

test('자율 진행: 지적은 master 가 고치고, 상한을 넘으면 사용자를 부르고, 끝나면 확정을 요청한다', async (t) => {
  const p = await autonomousProject();
  t.after(p.cleanup);
  assert.match(p.firstOut, /자율 진행: master 가/);
  assert.match(p.firstOut, /허용 명령\(autonomy\.json\)이 승인되지 않았다/);
  assert.equal(p.loadRun().autonomy.enabled, true);

  // master 의 설계 승인: 근거가 있어야 하고, 기록에 master 판단으로 남는다.
  let r = await p.run('design-check', ...F);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /설계 검사 통과 \(승인은 하지 않았다\)/);
  assert.equal(p.loadRun().approvals.design, null, 'design-check 는 승인하지 않는다');
  r = await p.run('approve', ...F, '--phase', 'design', '--by-master');
  assert.equal(r.code, 2);
  r = await p.run('approve', ...F, '--phase', 'design', '--by-master', '--reason', 'REQ 2개를 TASK-001 과 TEST-001 로 덮음, 범위는 src/pages/orders');
  assert.equal(r.code, 0, r.out);
  assert.equal(p.loadRun().approvals.design.by, 'master');
  assert.match(formatAlert(p.events().at(-1), SLACK), /^🔵 \*\[테스트 프로젝트\] \| 개발 \| 시작\*\n설계 v1\.0 master 승인/);
  git(p.projectRoot, 'add', '-A');
  git(p.projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');

  await p.run('task-start', ...F, '--task', 'TASK-001');
  fs.mkdirSync(path.join(p.projectRoot, 'src/pages/orders'), { recursive: true });
  fs.writeFileSync(path.join(p.projectRoot, 'src/pages/orders/List.tsx'), 'v1');
  assert.equal((await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '목록')).code, 0);

  // 1차 지적: master 가 고친다. 사용자를 부르지 않는다.
  p.extra.runProcess = fakeCodex([reviewJson('CHANGES_REQUESTED', FINDING), reviewJson('CHANGES_REQUESTED', FINDING), reviewJson('APPROVED')]);
  r = await p.run('review', ...F);
  assert.doesNotMatch(r.out, /\[확인 필요\]/);
  assert.equal(p.loadRun().waiting ?? null, null);
  const first = p.events().at(-1);
  assert.equal(first.decision, null);
  assert.equal(formatAlert(first, SLACK), '🔵 *[테스트 프로젝트] | 검수 | 진행*\nCodex 지적 1건 (중요 1) — master 가 고치는 중 (1/2).\n고치고 나면 다시 검수합니다.');

  // 2차 지적: 상한(2) — 사용자를 부른다.
  await p.run('task-reopen', ...F, '--task', 'TASK-001', '--reason', 'R001');
  await p.run('task-start', ...F, '--task', 'TASK-001');
  fs.writeFileSync(path.join(p.projectRoot, 'src/pages/orders/List.tsx'), 'v2');
  await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '고침');
  r = await p.run('review', ...F);
  assert.match(r.out, /\[확인 필요\] Codex 검수 지적/);
  assert.equal(p.loadRun().waiting.kind, 'limit');
  assert.match(formatAlert(p.events().at(-1), SLACK), /^<@U0123456789> 🟠 \*\[테스트 프로젝트\] \| 검수 \| 확인 필요\*\n재시도 상한: Codex 지적이 2번째다/);

  // 사용자 대기 중에는 master 가 승인하지 못한다. 사용자 답으로 재개한다.
  r = await p.run('resume', ...F);
  assert.equal(r.code, 2);
  r = await p.run('resume', ...F, '--approval-text', '한 번 더 검수해 봐', '--user-confirmed');
  assert.equal(r.code, 0, r.out);
  assert.equal(p.loadRun().waiting, null);
  assert.match(formatAlert(p.events().at(-1), SLACK), /^🔵 \*\[테스트 프로젝트\] \| 검수 \| 진행\*\n사용자 답변을 받아 재개했습니다\./);

  // 검수 통과 → 검증 통과 → 완료 보고와 확정 요청 (멘션).
  r = await p.run('review', ...F);
  assert.equal(r.code, 0, r.out);
  r = await p.run('verify', ...F);
  assert.match(r.out, /설계·개발·검수·검증 완료[\s\S]*\[확인 필요\] 검수·검증이 모두 통과했습니다/);
  assert.equal(p.loadRun().waiting.kind, 'confirm');
  assert.match(formatAlert(p.events().at(-1), SLACK), /^<@U0123456789> 🟠 \*\[테스트 프로젝트\] \| 확정 \| 확인 필요\*\n완료 보고: 설계·개발·검수·검증 완료 — 작업 1개[\s\S]*할 일: Claude Code 에서 선택 — 확정한다 \/ 더 확인한다$/);

  // 사용자 확정이 대기를 끝낸다.
  r = await p.run('confirm', ...F, ...CONFIRMED);
  assert.equal(r.code, 0, r.out);
  assert.equal(p.loadRun().waiting, null);
  assert.equal(p.loadRun().phase, 'DOCS');
});

test('자율 진행이 아니면 master 가 설계를 승인할 수 없다', async (t) => {
  const p = await autonomousProject({ autonomous: false });
  t.after(p.cleanup);
  const r = await p.run('approve', ...F, '--phase', 'design', '--by-master', '--reason', '충분히 긴 근거 문장입니다');
  assert.equal(r.code, 3);
  assert.match(r.out, /NOT_AUTONOMOUS/);
  assert.equal(await p.hook('Stop', { stop_hook_active: false }), null, '자율 진행이 아니면 멈춤을 막지 않는다');
  assert.equal(await p.hook('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: 'a' } }), null);
});

test('세션 훅: 권한 자동 허용, 멈춤 이어가기, 권한 대기 호출', async (t) => {
  const p = await autonomousProject();
  t.after(p.cleanup);
  const allow = (input) => p.hook('PermissionRequest', input).then((o) => o?.hookSpecificOutput?.decision?.behavior ?? null);
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

  assert.equal(await allow({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }), 'allow');
  assert.equal(await allow(bash(`${CLI} status --feature FEAT-001`)), 'allow', '엔진 명령');
  assert.equal(await allow(bash(`${CLI} confirm --feature FEAT-001 --approval-text "x" --user-confirmed`)), null, '사용자 승인은 자동 허용하지 않는다');
  assert.equal(await allow(bash('npm test')), null, '허용 명령을 승인하기 전');
  const list = path.join(p.projectRoot, '..', `${path.basename(p.projectRoot)}-allow.json`);
  fs.writeFileSync(list, JSON.stringify({ allow: ['npm test', 'git status'] }));
  assert.equal((await p.run('autonomy-set', '--from', list, ...CONFIRMED)).code, 0);
  assert.equal(await allow(bash('npm test')), 'allow');
  assert.equal(await allow(bash('npm test -- --watch=false')), 'allow');
  assert.equal(await allow(bash('npm testx')), null);
  assert.equal(await allow(bash('npm test && curl evil')), null);
  assert.equal(await allow(bash(`${CLI} verify --feature FEAT-001 --only TEST-001 ; ${CLI} status 2>&1 | tail -5`)), 'allow', '허용 명령끼리 이은 것은 허용');
  assert.equal(await allow(bash(`${CLI} status && rm -rf src`)), null, '하나라도 허용 밖이면 권한 확인');
  assert.equal(await allow(bash('npm test | sh')), null);
  assert.equal(await allow(bash('cd "' + p.projectRoot + '" && echo "== REQ-001"; npm test 2>&1 | grep -E "^# (pass|fail)" | head -5')), 'allow', '프로젝트 안 cd, echo, 출력 필터');
  assert.equal(await allow(bash('cd .. && npm test')), null, '프로젝트 밖으로 cd');
  assert.equal(await allow(bash('npm test | grep x > out.txt')), null, '필터 뒤 리다이렉션');
  // 승인 뒤 파일을 고치면 허용하지 않는다.
  const file = path.join(p.workflowRoot, 'autonomy.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.allow.push('rm');
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(await allow(bash('npm test')), null);

  // 권한 확인으로 넘어간 명령은 Notification 이 사용자를 부른다.
  assert.equal(await allow(bash('curl https://example.com')), null);
  await p.hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(p.loadRun().waiting.kind, 'permission');
  const alert = formatAlert(p.events().at(-1), SLACK);
  assert.match(alert, /^<@U0123456789> 🟠 .*\n권한 확인 대기: `curl https:\/\/example\.com`/);
  assert.equal(await p.hook('Stop', { stop_hook_active: false }), null, '사용자를 기다리는 중이면 멈춰도 된다');
  await p.run('resume', ...F, '--approval-text', 'curl 허용했어', '--user-confirmed');

  // 멈추려 하면 이어가게 하고, 진행 없이 거듭 멈추면 사용자를 부른다.
  let out = await p.hook('Stop', { stop_hook_active: false });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /자율 진행[\s\S]*escalate --feature FEAT-001/);
  out = await p.hook('Stop', { stop_hook_active: true });
  assert.equal(out.decision, 'block');
  out = await p.hook('Stop', { stop_hook_active: true });
  assert.equal(out.decision, 'block');
  out = await p.hook('Stop', { stop_hook_active: true });
  assert.equal(out, null);
  assert.equal(p.loadRun().waiting.kind, 'stalled');
  assert.match(formatAlert(p.events().at(-1), SLACK), /^<@U0123456789> 🟠 .*\n세션 멈춤: master 가/);
});

test('escalate: master 가 선택지와 함께 사용자를 부른다', async (t) => {
  const p = await autonomousProject();
  t.after(p.cleanup);
  let r = await p.run('escalate', ...F, '--kind', 'plan', '--summary', '주문 상태 값이 기획과 API 가 다르다', '--option', '기획대로::API 를 바꾼다');
  assert.equal(r.code, 2, '선택지는 0개 또는 2~4개');
  r = await p.run('escalate', ...F, '--kind', 'plan', '--summary', '주문 상태 값이 기획과 API 가 다르다', '--option', '기획대로::API 를 바꾼다', '--option', 'API 대로::기획을 고친다');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[확인 필요\] 주문 상태 값이[\s\S]*1\. 기획대로 — API 를 바꾼다[\s\S]*2\. API 대로/);
  assert.equal(formatAlert(p.events().at(-1), SLACK),
    '<@U0123456789> 🟠 *[테스트 프로젝트] | 설계 | 확인 필요*\n기획 확인 필요: 주문 상태 값이 기획과 API 가 다르다\n할 일: Claude Code 에서 선택 — 기획대로 / API 대로');
});
