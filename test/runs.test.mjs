import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configuredProject, REQUIREMENTS, DESIGN, TASK, APPROVE, tasksJson, testsJson } from './helpers.mjs';
import { readJsonl } from '../engine/util.mjs';

async function toDesignPhase(p) {
  await p.run('new', '--title', '주문 상태 필터');
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS);
  const r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'plan', ...APPROVE);
  assert.equal(r.code, 0, r.out);
}

async function toDevelopPhase(p) {
  await toDesignPhase(p);
  p.write('features/FEAT-001/design.md', DESIGN);
  p.write('features/FEAT-001/tests.json', testsJson());
  p.write('features/FEAT-001/tasks.json', tasksJson([TASK]));
  const r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'design', ...APPROVE);
  assert.equal(r.code, 0, r.out);
}

function loadRun(p) {
  const dir = path.join(p.workflowRoot, 'runs');
  const [runId] = fs.readdirSync(dir);
  return JSON.parse(fs.readFileSync(path.join(dir, runId, 'run.json'), 'utf8'));
}

test('new: 설정이 없으면 막고, 있으면 기능 문서를 프로젝트 이름으로 만든다', async (t) => {
  const p = await configuredProject();
  t.after(p.cleanup);
  let r = await p.run('new');
  assert.equal(r.code, 2);
  r = await p.run('new', '--title', '주문 상태 필터');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /FEAT-001 \/ RUN-20261007-001/);
  const decisions = fs.readFileSync(path.join(p.featureDir(), 'decisions.md'), 'utf8');
  assert.match(decisions, /테스트 프로젝트/);
  assert.match(decisions, /FEAT-001 주문 상태 필터/);
  r = await p.run('new', '--title', '다시', '--feature', 'FEAT-001');
  assert.equal(r.code, 1);
  assert.match(r.out, /RUN_EXISTS/);
  r = await p.run('new', '--title', '두 번째');
  assert.match(r.out, /FEAT-002 \/ RUN-20261007-002/);
});

test('approve plan: 사용자 확인·명세 버전·REQ·미결 질문 관문', async (t) => {
  const p = await configuredProject();
  t.after(p.cleanup);
  await p.run('new', '--title', '기능');
  let r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'plan', '--approval-text', '진행해');
  assert.equal(r.code, 2, '--user-confirmed 없이 승인 불가');
  r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'plan', ...APPROVE);
  assert.match(r.out, /REQUIREMENTS_EMPTY/, '템플릿 그대로는 승인 불가');
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS.replace('명세 버전: v1.0', ''));
  r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'plan', ...APPROVE);
  assert.match(r.out, /REQUIREMENTS_VERSION_MISSING/);
  p.write('features/FEAT-001/requirements.md', `${REQUIREMENTS}- Q-001: 기본값은?\n`);
  r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'plan', ...APPROVE);
  assert.match(r.out, /OPEN_QUESTIONS.*Q-001/);
  p.write('features/FEAT-001/requirements.md', REQUIREMENTS);
  r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'plan', ...APPROVE);
  assert.equal(r.code, 0, r.out);
  const run = loadRun(p);
  assert.equal(run.phase, 'DESIGN');
  assert.deepEqual(run.approvals.plan.requirementIds, ['REQ-001', 'REQ-002']);
  assert.equal(run.approvals.plan.approvalText, '진행해');
});

test('approve design: 작업 계약·요구사항 연결·허용 범위 검증', async (t) => {
  const p = await configuredProject();
  t.after(p.cleanup);
  await toDesignPhase(p);
  p.write('features/FEAT-001/design.md', DESIGN);
  p.write('features/FEAT-001/tests.json', testsJson());
  const attempt = async (tasks) => {
    p.write('features/FEAT-001/tasks.json', tasksJson(tasks));
    return p.run('approve', '--feature', 'FEAT-001', '--phase', 'design', ...APPROVE);
  };
  let r = await attempt([{ ...TASK, requirementIds: ['REQ-001'] }]);
  assert.match(r.out, /REQUIREMENTS_UNCOVERED.*REQ-002/);
  r = await attempt([{ ...TASK, allowedFiles: ['../outside.ts'] }]);
  assert.match(r.out, /TASK_INVALID/);
  r = await attempt([{ ...TASK, allowedFiles: ['**'] }]);
  assert.match(r.out, /프로젝트 전체/);
  r = await attempt([{ ...TASK, requirementIds: ['REQ-001', 'REQ-009'] }]);
  assert.match(r.out, /REQ-009/);
  r = await attempt([
    { ...TASK, id: 'TASK-001', requirementIds: ['REQ-001'], dependsOn: ['TASK-002'] },
    { ...TASK, id: 'TASK-002', requirementIds: ['REQ-002'], dependsOn: ['TASK-001'] },
  ]);
  assert.match(r.out, /순환 의존/);
  r = await attempt([
    { ...TASK, id: 'TASK-001', requirementIds: ['REQ-001'], dependsOn: ['TASK-002'] },
    { ...TASK, id: 'TASK-002', requirementIds: ['REQ-002'] },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /TASK-002 → TASK-001/);
  const run = loadRun(p);
  assert.equal(run.phase, 'DEVELOP');
  assert.deepEqual(Object.keys(run.tasks).sort(), ['TASK-001', 'TASK-002']);
});

test('설계·작업 목록이 바뀌면 설계 승인만 되돌린다', async (t) => {
  const p = await configuredProject();
  t.after(p.cleanup);
  await toDevelopPhase(p);
  p.write('features/FEAT-001/tasks.json', tasksJson([{ ...TASK, goal: '바뀐 목표' }]));
  let r = await p.run('status');
  assert.match(r.out, /TASKS_CHANGED/);
  r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'design', ...APPROVE);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /승인을 되돌렸다: TASKS_CHANGED/);
  const run = loadRun(p);
  assert.ok(run.approvals.plan, '기획 승인은 유지');
  assert.equal(run.approvals.design.seq, 3);
  assert.equal(run.approvalHistory.length, 1);
});

test('요구사항이 바뀌면 기획·설계 승인을 모두 되돌리고 논의 단계로 간다', async (t) => {
  const p = await configuredProject();
  t.after(p.cleanup);
  await toDevelopPhase(p);
  p.write('features/FEAT-001/requirements.md', `${REQUIREMENTS}- REQ-003: 추가 요구\n`);
  const r = await p.run('approve', '--feature', 'FEAT-001', '--phase', 'design', ...APPROVE);
  assert.equal(r.code, 3);
  assert.match(r.out, /WRONG_PHASE/);
  const run = loadRun(p);
  assert.equal(run.phase, 'DISCUSS');
  assert.equal(run.approvals.plan, null);
  assert.equal(run.approvals.design, null);
  assert.equal(run.approvalHistory.length, 2);
  const events = readJsonl(path.join(p.workflowRoot, 'runs', run.runId, 'events.jsonl')).records.map((e) => e.type);
  assert.deepEqual(events, ['RUN_CREATED', 'REQUIREMENTS_CONFIRMED', 'DESIGN_CONFIRMED', 'REQUIREMENTS_UPDATED']);
});

test('잠금이 잡혀 있으면 종료 코드 4', async (t) => {
  const p = await configuredProject();
  t.after(p.cleanup);
  fs.mkdirSync(path.join(p.workflowRoot, 'state'), { recursive: true });
  fs.writeFileSync(path.join(p.workflowRoot, 'state', 'controller.lock'), JSON.stringify({ pid: 1, hostname: 'other-host', command: 'x' }));
  const r = await p.run('new', '--title', '기능');
  assert.equal(r.code, 4);
  assert.match(r.out, /LOCK_HELD/);
});
