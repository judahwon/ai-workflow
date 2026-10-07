import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configuredProject, git, REQUIREMENTS, DESIGN, TASK, APPROVE, tasksJson, testsJson } from './helpers.mjs';
import { readJsonl } from '../engine/util.mjs';
import { patternToRegExp, matchesAllowed } from '../engine/scope.mjs';
import { runHook } from '../engine/hook.mjs';

const TASKS = [
  { ...TASK, id: 'TASK-001', requirementIds: ['REQ-001'], allowedFiles: ['src/pages/orders/**'] },
  { ...TASK, id: 'TASK-002', requirementIds: ['REQ-002'], allowedFiles: ['src/api/orders.ts'], dependsOn: ['TASK-001'] },
];

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

async function developProject(tasks = TASKS) {
  const p = await configuredProject();
  await p.run('new', '--title', '주문 상태 필터');
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS);
  let r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'plan', ...APPROVE);
  assert.equal(r.code, 0, r.out);
  p.write('features/FEAT-001/design.md', DESIGN);
  p.write('features/FEAT-001/tests.json', testsJson());
  p.write('features/FEAT-001/tasks.json', tasksJson(tasks));
  r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'design', ...APPROVE);
  assert.equal(r.code, 0, r.out);
  commitAll(p);
  const hook = (filePath, tool = 'Edit') => runHook(JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath } }), p.overrides);
  return { ...p, hook };
}

const F = ['--feature', 'FEAT-001'];

test('patternToRegExp: **·*·? 와 glob 없는 폴더 경로', () => {
  const ok = (pattern, file, options) => assert.ok(patternToRegExp(pattern, options).test(file), `${pattern} ~ ${file}`);
  const no = (pattern, file) => assert.ok(!patternToRegExp(pattern).test(file), `${pattern} !~ ${file}`);
  ok('src/pages/**', 'src/pages/a.ts');
  ok('src/pages/**', 'src/pages/x/y/z.ts');
  no('src/pages/**', 'src/pagesX/a.ts');
  ok('src/*.ts', 'src/a.ts');
  no('src/*.ts', 'src/x/a.ts');
  ok('**/*.test.ts', 'a.test.ts');
  ok('**/*.test.ts', 'x/y/a.test.ts');
  ok('src/a?.ts', 'src/ab.ts');
  ok('src/lib', 'src/lib');
  ok('src/lib', 'src/lib/deep/x.ts');
  no('src/lib', 'src/library.ts');
  no('src/a.ts', 'src/a.tsx');
  no('src/a.ts', 'SRC/A.ts');
  ok('src/a.ts', 'SRC/A.ts', { ignoreCase: true });
  assert.ok(matchesAllowed('src/b.ts', ['src/a.ts', 'src/*.ts']));
});

test('task-start: 의존 작업·진행 중 작업 하나 규칙', async (t) => {
  const p = await developProject([
    TASKS[0],
    TASKS[1],
  ]);
  t.after(p.cleanup);
  let r = await p.run('task-start', ...F, '--task', 'TASK-002');
  assert.match(r.out, /DEPENDENCY_PENDING.*TASK-001/);
  r = await p.run('task-start', ...F, '--task', 'TASK-009');
  assert.match(r.out, /TASK_NOT_IN_APPROVAL/);
  r = await p.run('task-start', ...F, '--task', 'TASK-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /src\/pages\/orders\/\*\*/);
  assert.ok(fs.existsSync(path.join(p.workflowRoot, 'state', 'focus.json')));
  assert.equal(loadRun(p).tasks['TASK-001'].status, 'IN_PROGRESS');
});

test('진행 중인 작업은 하나뿐이고 task-pause 로 넘길 수 있다', async (t) => {
  const p = await developProject([
    { ...TASKS[0] },
    { ...TASKS[1], dependsOn: [] },
  ]);
  t.after(p.cleanup);
  let r = await p.run('task-start', ...F, '--task', 'TASK-001');
  assert.equal(r.code, 0, r.out);
  r = await p.run('task-start', ...F, '--task', 'TASK-002');
  assert.match(r.out, /FOCUS_HELD.*TASK-001/);
  r = await p.run('task-pause');
  assert.equal(r.code, 0, r.out);
  r = await p.run('task-start', ...F, '--task', 'TASK-002');
  assert.equal(r.code, 0, r.out);
  // 같은 작업을 다시 시작하면 재개로 처리하고 시작 기준을 유지한다.
  r = await p.run('task-start', ...F, '--task', 'TASK-002');
  assert.match(r.out, /재개/);
  assert.equal(loadRun(p).tasks['TASK-002'].attempts.length, 1);
});

test('훅·check-scope: 진행 중 작업의 허용 범위만 통과시킨다', async (t) => {
  const p = await developProject();
  t.after(p.cleanup);
  const abs = (rel) => path.join(p.projectRoot, rel);
  // 작업이 없을 때는 보호 경로만 막는다.
  assert.equal(p.hook(abs('src/anything.ts')), null);
  assert.match(p.hook(abs('.ai-workflow/engine/cli.mjs')).hookSpecificOutput.permissionDecisionReason, /엔진/);
  assert.equal(p.hook(abs('.ai-workflow/.env'), 'Write').hookSpecificOutput.permissionDecision, 'deny');

  await p.run('task-start', ...F, '--task', 'TASK-001');
  assert.equal(p.hook(abs('src/pages/orders/List.tsx')), null);
  assert.equal(p.hook('src/pages/orders/new/Form.tsx', 'Write'), null, '상대 경로');
  const denied = p.hook(abs('src/api/orders.ts'));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /TASK-001 의 수정 허용 범위 밖/);
  assert.equal(p.hook(abs('.ai-workflow/features/FEAT-001/design.md')), null, '기능 문서는 고칠 수 있다');
  assert.equal(p.hook(abs('.claude/settings.json')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), p.overrides), null);
  assert.equal(runHook('not json', p.overrides), null);
  const withBom = `﻿${JSON.stringify({ tool_name: 'Write', tool_input: { file_path: abs('.ai-workflow/.env') } })}\r\n`;
  assert.equal(runHook(withBom, p.overrides).hookSpecificOutput.permissionDecision, 'deny', 'BOM 이 붙어도 판단한다');

  let r = await p.run('check-scope', '--path', 'src/api/orders.ts');
  assert.equal(r.code, 3);
  assert.match(r.out, /차단/);
  r = await p.run('check-scope', '--path', 'src/pages/orders/a.ts');
  assert.equal(r.code, 0, r.out);
});

test('task-done: git 으로 범위 밖 변경을 잡고, 사용자 허락으로만 넘긴다', async (t) => {
  const p = await developProject();
  t.after(p.cleanup);
  writeSource(p, 'notes/before.md', '시작 전부터 있던 변경');
  await p.run('task-start', ...F, '--task', 'TASK-001');
  writeSource(p, 'src/pages/orders/List.tsx');
  writeSource(p, 'src/other.ts');
  // 작업 도중 install --upgrade 가 바꾸는 파일
  writeSource(p, '.ai-workflow/engine/cli.mjs', '// upgraded');
  writeSource(p, '.claude/skills/aiwf-docs/SKILL.md', 'upgraded');
  let r = await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '목록 추가');
  assert.equal(r.code, 3);
  assert.match(r.out, /OUT_OF_SCOPE/);
  assert.match(r.out, /src\/other\.ts/);
  assert.match(r.out, /\[확인 필요\] TASK-001 의 수정 범위 밖 파일 1개가 바뀌었습니다[\s\S]*1\. 허락한다[\s\S]*2\. 되돌린다[\s\S]*3\. 범위를 고친다/);
  assert.doesNotMatch(r.out, /engine\/cli\.mjs|aiwf-docs/, '설치기가 바꾸는 파일은 작업의 변경이 아니다');
  assert.doesNotMatch(r.out, /notes\/before\.md/, '시작 전 변경은 이 작업의 변경이 아니다');
  r = await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '목록 추가', '--extra-approved', '괜찮아');
  assert.equal(r.code, 2, '--user-confirmed 필요');
  r = await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '목록 추가', '--extra-approved', '그 파일은 괜찮아', '--user-confirmed');
  assert.equal(r.code, 0, r.out);
  const attempt = loadRun(p).tasks['TASK-001'].attempts[0];
  assert.deepEqual(attempt.changedFiles, ['src/pages/orders/List.tsx']);
  assert.deepEqual(attempt.extraApproved.files, ['src/other.ts']);
  assert.ok(!fs.existsSync(path.join(p.workflowRoot, 'state', 'focus.json')), 'focus 해제');
});

test('task-done: 시작 전 변경 파일도 내용이 다시 바뀌면 이 작업의 변경으로 본다', async (t) => {
  const p = await developProject();
  t.after(p.cleanup);
  writeSource(p, 'src/shared.ts', 'v1');
  await p.run('task-start', ...F, '--task', 'TASK-001');
  writeSource(p, 'src/shared.ts', 'v2');
  writeSource(p, 'src/pages/orders/List.tsx');
  const r = await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '완료');
  assert.match(r.out, /OUT_OF_SCOPE[\s\S]*src\/shared\.ts/);
});

test('모든 작업이 끝나면 검수 단계로 간다', async (t) => {
  const p = await developProject();
  t.after(p.cleanup);
  await p.run('task-start', ...F, '--task', 'TASK-001');
  writeSource(p, 'src/pages/orders/List.tsx');
  let r = await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '목록');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /남은 작업: TASK-002/);
  commitAll(p, '작업 1');
  r = await p.run('task-done', ...F, '--task', 'TASK-002', '--summary', 'api');
  assert.match(r.out, /TASK_NOT_STARTED/);
  await p.run('task-start', ...F, '--task', 'TASK-002');
  writeSource(p, 'src/api/orders.ts');
  r = await p.run('task-done', ...F, '--task', 'TASK-002', '--summary', 'api 추가');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /검수/);
  const run = loadRun(p);
  assert.equal(run.phase, 'REVIEW');
  const events = readJsonl(path.join(p.workflowRoot, 'runs', run.runId, 'events.jsonl')).records.map((e) => e.type);
  assert.deepEqual(events.slice(-4), ['TASK_STARTED', 'TASK_DONE', 'TASK_STARTED', 'TASK_DONE']);
});

test('작업 중 설계가 바뀌면 코드 수정과 완료를 막는다', async (t) => {
  const p = await developProject();
  t.after(p.cleanup);
  await p.run('task-start', ...F, '--task', 'TASK-001');
  p.write('features/FEAT-001/tasks.json', tasksJson([{ ...TASKS[0], allowedFiles: ['src/**'] }, TASKS[1]]));
  const denied = p.hook(path.join(p.projectRoot, 'src/pages/orders/List.tsx'));
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /다시 승인/);
  let r = await p.run('task-done', ...F, '--task', 'TASK-001', '--summary', '완료');
  assert.match(r.out, /APPROVAL_DRIFT/);
  assert.equal(loadRun(p).phase, 'DESIGN');
  assert.match(p.hook(path.join(p.projectRoot, 'src/pages/orders/List.tsx')).hookSpecificOutput.permissionDecisionReason, /더 이상 진행 중이 아니다/);
  r = await p.run('task-pause');
  assert.equal(r.code, 0, r.out);
  assert.equal(p.hook(path.join(p.projectRoot, 'src/pages/orders/List.tsx')), null);
});
