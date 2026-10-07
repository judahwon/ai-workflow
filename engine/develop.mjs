// 개발 단계: 작업 시작·일시 중지·완료와 수정 범위 판단.
// 진행 중인 작업(focus)은 하나뿐이고, 훅은 그 작업의 allowedFiles 밖 수정을 막는다.
// 훅을 우회한 수정(셸 명령 등)은 task-done 이 git 기준 변경 파일로 다시 확인한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blocked, usageError, assertId, readJson, writeJsonAtomic, redact } from './util.mjs';
import { withLock } from './lock.mjs';
import { appendEvent } from './events.mjs';
import { requireValidConfig, requireEnvIgnored } from './config.mjs';
import { loadRun, saveRun, resolveRun, syncApprovals, detectApprovalDrift, PHASE_LABELS } from './runs.mjs';
import {
  matchesAllowed, toProjectRelative, protectedReason, featureDocPrefix,
  captureBaseline, changedSinceBaseline, classifyChanges,
} from './scope.mjs';

export function ignoreCase(ctx) {
  return ctx.platform === 'win32' || ctx.platform === 'darwin';
}

// ---------- 진행 중 작업(focus) ----------

export function focusFile(ctx) {
  return path.join(ctx.workflowRoot, 'state', 'focus.json');
}

export function readFocus(ctx) {
  const file = focusFile(ctx);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function writeFocus(ctx, focus) {
  writeJsonAtomic(focusFile(ctx), focus);
}

function clearFocus(ctx) {
  fs.rmSync(focusFile(ctx), { force: true });
}

// focus 가 가리키는 작업이 아직 진행 중인지. 설계 승인이 바뀌어 단계가 되돌아가면 무효다.
function focusIsLive(run, focus) {
  return run.runId === focus.runId && run.phase === 'DEVELOP' && run.tasks[focus.taskId]?.status === 'IN_PROGRESS';
}

function taskContract(run, taskId) {
  const entry = run.approvals.design?.tasks?.[taskId];
  if (!entry) throw blocked('TASK_NOT_IN_APPROVAL', `${taskId} 는 승인된 작업 목록에 없다.`);
  return entry.contract;
}

function requireDevelopRun(ctx, opts) {
  const run = resolveRun(ctx, opts);
  const drift = syncApprovals(ctx, run);
  if (drift.length) {
    throw blocked('APPROVAL_DRIFT', `승인 이후 문서가 바뀌어 승인을 되돌렸다 (${drift.map((d) => d.reason).join(', ')}). 바뀐 내용을 사용자와 확인하고 다시 승인받는다. 현재 단계: ${PHASE_LABELS[run.phase]}`);
  }
  if (run.phase !== 'DEVELOP') throw blocked('WRONG_PHASE', `개발 단계가 아니다 (현재 ${PHASE_LABELS[run.phase] ?? run.phase}).`);
  return run;
}

function describeContract(task) {
  return [
    `${task.id} ${task.title}  (요구사항 ${task.requirementIds.join(', ')})`,
    `목표: ${task.goal}`,
    '수정 허용 범위:',
    ...task.allowedFiles.map((p) => `  - ${p}`),
    '완료 조건:',
    ...task.completionCriteria.map((c) => `  - ${c}`),
    ...(task.stopConditions?.length ? ['멈출 조건:', ...task.stopConditions.map((c) => `  - ${c}`)] : []),
  ];
}

// ---------- 명령: task-start ----------

export async function cmdTaskStart(ctx, opts) {
  requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  const taskId = assertId('task', opts.task);
  return withLock(ctx, 'task-start', async () => {
    const run = requireDevelopRun(ctx, opts);
    const task = taskContract(run, taskId);
    const state = run.tasks[taskId];
    if (state.status === 'DONE') throw blocked('TASK_DONE', `${taskId} 는 이미 완료됐다.`);
    const pending = (task.dependsOn ?? []).filter((d) => run.tasks[d]?.status !== 'DONE');
    if (pending.length) throw blocked('DEPENDENCY_PENDING', `먼저 끝내야 하는 작업: ${pending.join(', ')}`);

    const focus = readFocus(ctx);
    if (focus && !(focus.runId === run.runId && focus.taskId === taskId)) {
      let live = false;
      try {
        live = focusIsLive(loadRun(ctx, focus.runId), focus);
      } catch { /* 실행이 사라졌으면 남은 focus 는 버린다 */ }
      if (live) throw blocked('FOCUS_HELD', `진행 중인 작업이 있다: ${focus.featureId} ${focus.taskId}. task-done 또는 task-pause 를 먼저 한다.`);
    }

    const resumed = state.status === 'IN_PROGRESS';
    if (!resumed) {
      state.status = 'IN_PROGRESS';
      state.attempts ??= [];
      state.attempts.push({ startedAt: ctx.now(), baseline: captureBaseline(ctx) });
    }
    saveRun(ctx, run);
    writeFocus(ctx, { runId: run.runId, featureId: run.featureId, taskId, since: ctx.now() });
    const baseline = state.attempts.at(-1).baseline;
    appendEvent(ctx, run, {
      type: resumed ? 'TASK_RESUMED' : 'TASK_STARTED',
      taskId,
      attempt: state.attempts.length,
      status: 'IN_PROGRESS',
      summary: `${taskId} ${task.title} ${resumed ? '재개' : '시작'}`,
      nextAction: '수정 허용 범위 안에서 구현하고 완료 조건을 확인한 뒤 task-done 한다.',
    });
    const lines = [`${resumed ? '재개' : '시작'}: ${run.featureId} ${run.runId}`, ...describeContract(task)];
    if (!baseline) lines.push('', '[주의] git 저장소가 아니라 완료 시 변경 파일 범위를 확인하지 못한다.');
    else if (Object.keys(baseline.dirty).length) {
      lines.push('', `시작 전부터 바뀌어 있던 파일 ${Object.keys(baseline.dirty).length}개는 내용이 다시 바뀔 때만 이 작업의 변경으로 본다.`);
    }
    return { ok: true, message: lines.join('\n') };
  });
}

// ---------- 명령: task-pause ----------

export async function cmdTaskPause(ctx) {
  return withLock(ctx, 'task-pause', async () => {
    const focus = readFocus(ctx);
    if (!focus) return { ok: true, message: '진행 중인 작업이 없다.' };
    clearFocus(ctx);
    try {
      const run = loadRun(ctx, focus.runId);
      appendEvent(ctx, run, { type: 'TASK_PAUSED', taskId: focus.taskId, status: run.tasks[focus.taskId]?.status, summary: `${focus.taskId} 일시 중지` });
    } catch { /* 실행이 없어도 focus 해제는 끝났다 */ }
    return { ok: true, message: `${focus.featureId} ${focus.taskId} 일시 중지. 수정 범위 제한을 풀었다. 이어서 하려면 task-start 로 재개한다.` };
  });
}

// ---------- 명령: task-done ----------

export async function cmdTaskDone(ctx, opts) {
  requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  const taskId = assertId('task', opts.task);
  const summary = typeof opts.summary === 'string' ? opts.summary.trim() : '';
  if (summary.length < 2) throw usageError('--summary "<무엇을 바꿨고 완료 조건을 어떻게 확인했는지>" 가 필요하다.');
  const extraText = typeof opts['extra-approved'] === 'string' ? opts['extra-approved'].trim() : '';
  if (extraText && opts['user-confirmed'] !== true) throw usageError('--extra-approved 는 사용자 답변 원문이고 --user-confirmed 와 함께 쓴다.');

  return withLock(ctx, 'task-done', async () => {
    const run = requireDevelopRun(ctx, opts);
    const task = taskContract(run, taskId);
    const state = run.tasks[taskId];
    if (state.status !== 'IN_PROGRESS') throw blocked('TASK_NOT_STARTED', `${taskId} 는 진행 중이 아니다 (${state.status}). task-start 를 먼저 한다.`);
    const focus = readFocus(ctx);
    if (focus && focusIsLive(run, focus) && focus.taskId !== taskId) {
      throw blocked('FOCUS_HELD', `진행 중인 작업은 ${focus.taskId} 다.`);
    }

    const attempt = state.attempts.at(-1);
    const lines = [];
    if (attempt.baseline) {
      const changed = changedSinceBaseline(ctx, attempt.baseline);
      const { inScope, outOfScope, docs } = classifyChanges(changed, {
        allowedFiles: task.allowedFiles, featureId: run.featureId, ignoreCase: ignoreCase(ctx),
      });
      if (outOfScope.length && !extraText) {
        throw blocked('OUT_OF_SCOPE', [
          `${taskId} 의 수정 허용 범위 밖 파일이 바뀌었다:`,
          ...outOfScope.map((f) => `  - ${f}`),
          '되돌리거나, 사용자에게 보여주고 허락을 받아 --extra-approved "<사용자 답변 원문>" --user-confirmed 로 다시 실행한다.',
          '범위 자체가 잘못됐다면 tasks.json 을 고치고 설계를 다시 승인받는다.',
        ].join('\n'));
      }
      attempt.changedFiles = inScope;
      attempt.docFiles = docs;
      if (outOfScope.length) {
        attempt.extraApproved = { files: outOfScope, approvalText: redact(extraText).slice(0, 2000), approvedAt: ctx.now() };
      }
      lines.push(`바뀐 파일: 범위 안 ${inScope.length}개, 기능 문서 ${docs.length}개${outOfScope.length ? `, 사용자 허락 범위 밖 ${outOfScope.length}개` : ''}`);
      if (inScope.length === 0) lines.push('[주의] 범위 안에서 바뀐 파일이 없다.');
    } else {
      attempt.scopeUnchecked = true;
      lines.push('[주의] git 저장소가 아니라 변경 파일 범위를 확인하지 않았다.');
    }
    attempt.finishedAt = ctx.now();
    attempt.summary = redact(summary).slice(0, 4000);
    state.status = 'DONE';
    if (focus?.runId === run.runId && focus.taskId === taskId) clearFocus(ctx);

    const order = run.approvals.design.order;
    const remaining = order.filter((id) => run.tasks[id]?.status !== 'DONE');
    if (remaining.length === 0) run.phase = 'REVIEW';
    saveRun(ctx, run);
    appendEvent(ctx, run, {
      type: 'TASK_DONE',
      taskId,
      attempt: state.attempts.length,
      status: 'DONE',
      summary: `${taskId} 완료: ${summary.slice(0, 300)}`,
      evidencePaths: attempt.changedFiles ?? [],
      nextAction: remaining.length ? `다음 작업: ${remaining[0]}` : '모든 작업 완료 — 검수 단계로 간다.',
    });
    lines.unshift(`${taskId} 완료.`);
    lines.push(remaining.length ? `남은 작업: ${remaining.join(', ')}` : `모든 작업 완료 — 단계: ${PHASE_LABELS.REVIEW}`);
    return { ok: true, message: lines.join('\n') };
  });
}

// ---------- 명령: task-reopen ----------

// 검수 지적·검증 실패를 고치려고 끝난 작업을 다시 연다. 개발 단계로 돌아가고 검수 결과는 무효가 된다.
export async function cmdTaskReopen(ctx, opts) {
  requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  const taskId = assertId('task', opts.task);
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason.length < 2) throw usageError('--reason "<다시 여는 이유 (검수 지적·실패 테스트 등)>" 가 필요하다.');
  return withLock(ctx, 'task-reopen', async () => {
    const run = resolveRun(ctx, opts);
    const drift = syncApprovals(ctx, run);
    if (drift.length) throw blocked('APPROVAL_DRIFT', `승인 이후 문서가 바뀌어 승인을 되돌렸다 (${drift.map((d) => d.reason).join(', ')}).`);
    if (!['REVIEW', 'VERIFY'].includes(run.phase)) throw blocked('WRONG_PHASE', `작업을 다시 여는 것은 검수·확정 단계에서만 한다 (현재 ${PHASE_LABELS[run.phase]}).`);
    taskContract(run, taskId);
    const state = run.tasks[taskId];
    if (state.status !== 'DONE') throw blocked('TASK_NOT_DONE', `${taskId} 는 완료 상태가 아니다 (${state.status}).`);
    state.status = 'PENDING';
    state.reopened = [...(state.reopened ?? []), { at: ctx.now(), reason: redact(reason).slice(0, 1000) }];
    run.reviewOutcome = null;
    run.phase = 'DEVELOP';
    saveRun(ctx, run);
    appendEvent(ctx, run, { type: 'TASK_REOPENED', taskId, status: 'DEVELOP', summary: `${taskId} 다시 열림`, reason, nextAction: `task-start --task ${taskId} 로 고친다. 끝나면 다시 검수한다.` });
    return { ok: true, message: `${taskId} 를 다시 열었다. 단계: ${PHASE_LABELS.DEVELOP}. task-start 로 이어서 고친다.` };
  });
}

// ---------- 수정 허용 판단 (훅·check-scope 공용) ----------

// 세션이 쓰는 임시·설정 폴더는 프로젝트 밖이어도 막지 않는다.
function harmlessOutside(ctx, filePath) {
  const abs = path.resolve(ctx.projectRoot, filePath);
  const roots = [os.tmpdir(), path.join(os.homedir(), '.claude')];
  return roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

function samePath(ctx, a, b) {
  return ignoreCase(ctx) ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

// 반환: { allow, reason }
export function decideEdit(ctx, filePath) {
  const options = { ignoreCase: ignoreCase(ctx) };
  const rel = toProjectRelative(ctx.projectRoot, filePath);
  if (ctx.userConfigFile && samePath(ctx, path.resolve(ctx.projectRoot, filePath), ctx.userConfigFile)) {
    return { allow: false, reason: `${filePath}: 워크플로 개인 설정 (init 으로만 바꾼다)` };
  }
  if (rel) {
    const reason = protectedReason(rel, options);
    if (reason) return { allow: false, reason: `${rel}: ${reason}` };
  }
  const focus = readFocus(ctx);
  if (!focus) return { allow: true, reason: '진행 중인 작업 없음' };
  if (!rel) {
    if (harmlessOutside(ctx, filePath)) return { allow: true, reason: '임시·설정 폴더' };
    return { allow: false, reason: `${focus.taskId} 진행 중에는 프로젝트 밖 파일을 고치지 않는다: ${filePath}` };
  }
  const run = loadRun(ctx, focus.runId);
  const docPrefix = featureDocPrefix(focus.featureId);
  if ((options.ignoreCase ? rel.toLowerCase() : rel).startsWith(options.ignoreCase ? docPrefix.toLowerCase() : docPrefix)) {
    return { allow: true, reason: '기능 문서 (바뀌면 해당 승인이 무효화된다)' };
  }
  if (!focusIsLive(run, focus)) {
    return { allow: false, reason: `${focus.taskId} 가 더 이상 진행 중이 아니다 (단계 ${run.phase}). status 로 확인하고 task-pause 로 정리한다.` };
  }
  const drift = detectApprovalDrift(ctx, run);
  if (drift.length) {
    return { allow: false, reason: `승인 이후 기능 문서가 바뀌었다 (${drift.map((d) => d.reason).join(', ')}). 사용자와 확인해 다시 승인받기 전에는 코드를 고치지 않는다.` };
  }
  const task = taskContract(run, focus.taskId);
  if (matchesAllowed(rel, task.allowedFiles, options)) return { allow: true, reason: `${focus.taskId} 허용 범위` };
  return {
    allow: false,
    reason: `${rel} 는 ${focus.taskId} 의 수정 허용 범위 밖이다 (허용: ${task.allowedFiles.join(', ')}). 꼭 필요하면 멈추고 사용자에게 알린다.`,
  };
}

export async function cmdCheckScope(ctx, opts) {
  if (typeof opts.path !== 'string' || !opts.path) throw usageError('--path <파일 경로> 가 필요하다.');
  const decision = decideEdit(ctx, opts.path);
  return { ok: decision.allow, message: `${decision.allow ? '허용' : '차단'}: ${decision.reason}` };
}
