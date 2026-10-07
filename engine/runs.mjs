// 기능 실행 상태와 단계 관문: 논의 → 기획 승인 → 설계 승인 → 개발 → 검수 → 확정 → 문서 → 완료.
// 승인은 사용자 답변 원문과 문서 해시에 묶이고, 문서가 바뀌면 해당 승인과 그 뒤 단계 승인이 무효가 된다.
import fs from 'node:fs';
import path from 'node:path';
import {
  WorkflowError, blocked, usageError, assertId, isValidId, hashJson, readJson, writeJsonAtomic,
  atomicWriteFile, redact,
} from './util.mjs';
import { withLock, inspectLock, breakStaleLock } from './lock.mjs';
import { appendEvent, runDir } from './events.mjs';
import { requireValidConfig, requireEnvIgnored, checkEnvIgnored } from './config.mjs';
import { featureDir, readRequirements, readDesign, hashIfExists } from './documents.mjs';
import { validateTaskList } from './tasks.mjs';
import { describeIgnore } from './init.mjs';

export const PHASES = ['DISCUSS', 'DESIGN', 'DEVELOP', 'REVIEW', 'VERIFY', 'DOCS', 'DONE'];

export const PHASE_LABELS = {
  DISCUSS: '논의·기획 (요구사항 승인 대기)',
  DESIGN: '설계 (설계·작업 승인 대기)',
  DEVELOP: '개발',
  REVIEW: '검수',
  VERIFY: '확정 (테스트·완료 판정)',
  DOCS: '문서 작성',
  DONE: '완료',
};

const FEATURE_FILES = ['decisions.md', 'requirements.md', 'design.md', 'tasks.json'];

// ---------- 실행 상태 ----------

function runFile(ctx, runId) {
  return path.join(runDir(ctx, runId), 'run.json');
}

export function loadRun(ctx, runId) {
  assertId('run', runId);
  const file = runFile(ctx, runId);
  if (!fs.existsSync(file)) throw new WorkflowError('RUN_NOT_FOUND', `실행 없음: ${runId}`);
  const run = readJson(file);
  if (run.runId !== runId) throw new WorkflowError('STATE_CORRUPT', 'run.json 의 runId 불일치.');
  return run;
}

export function saveRun(ctx, run) {
  run.updatedAt = ctx.now();
  writeJsonAtomic(runFile(ctx, run.runId), run);
}

export function listRuns(ctx) {
  const dir = path.join(ctx.workflowRoot, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => isValidId('run', name) && fs.existsSync(runFile(ctx, name)))
    .sort()
    .map((name) => loadRun(ctx, name));
}

export function activeRunForFeature(ctx, featureId) {
  return listRuns(ctx).filter((r) => r.featureId === featureId && r.phase !== 'DONE').at(-1) ?? null;
}

// --run 또는 --feature(진행 중 실행)로 실행을 찾는다.
export function resolveRun(ctx, opts) {
  if (opts.run) return loadRun(ctx, opts.run);
  if (opts.feature) {
    const run = activeRunForFeature(ctx, assertId('feature', opts.feature));
    if (!run) throw new WorkflowError('RUN_NOT_FOUND', `${opts.feature} 의 진행 중 실행이 없다.`);
    return run;
  }
  throw usageError('--run RUN-YYYYMMDD-NNN 또는 --feature FEAT-### 가 필요하다.');
}

function nextId(existing, prefix, width = 3) {
  const used = existing.map((id) => Number(id.slice(prefix.length))).filter(Number.isInteger);
  const next = (used.length ? Math.max(...used) : 0) + 1;
  if (next >= 10 ** width) throw new WorkflowError('ID_EXHAUSTED', `${prefix} 번호가 모두 쓰였다.`);
  return `${prefix}${String(next).padStart(width, '0')}`;
}

export function nextFeatureId(ctx) {
  const dir = path.join(ctx.workflowRoot, 'features');
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => isValidId('feature', n)) : [];
  return nextId(existing, 'FEAT-');
}

export function nextRunId(ctx) {
  const date = ctx.now().slice(0, 10).replace(/-/g, '');
  const prefix = `RUN-${date}-`;
  const dir = path.join(ctx.workflowRoot, 'runs');
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && isValidId('run', n)) : [];
  return nextId(existing, prefix);
}

// ---------- 승인 일관성 ----------

// 승인 이후 문서가 바뀌었는지 본다 (읽기 전용). 반환: [{ approval: 'plan'|'design', reason }]
export function detectApprovalDrift(ctx, run) {
  const drift = [];
  const plan = run.approvals.plan;
  if (plan && hashIfExists(ctx, run.featureId, 'requirements.md') !== plan.hash) {
    drift.push({ approval: 'plan', reason: 'REQUIREMENTS_CHANGED' });
  }
  const design = run.approvals.design;
  if (design) {
    if (hashIfExists(ctx, run.featureId, 'design.md') !== design.hash) drift.push({ approval: 'design', reason: 'DESIGN_CHANGED' });
    else if (currentTasksHash(ctx, run) !== design.tasksHash) drift.push({ approval: 'design', reason: 'TASKS_CHANGED' });
  }
  return drift;
}

function currentTasksHash(ctx, run) {
  try {
    const data = readJson(path.join(featureDir(ctx, run.featureId), 'tasks.json'));
    return Array.isArray(data?.tasks) ? hashJson(data.tasks) : null;
  } catch {
    return null;
  }
}

function invalidate(ctx, run, which, reason) {
  const approval = run.approvals[which];
  if (!approval) return;
  run.approvalHistory.push({ ...approval, invalidatedAt: ctx.now(), invalidReason: reason });
  run.approvals[which] = null;
}

// 잠금 안에서 호출한다. 문서가 바뀌었으면 해당 승인과 뒤 단계 승인을 무효화하고 단계를 되돌린다.
export function syncApprovals(ctx, run) {
  const drift = detectApprovalDrift(ctx, run);
  if (drift.length === 0) return drift;
  const planChanged = drift.some((d) => d.approval === 'plan');
  const reasons = drift.map((d) => d.reason).join(', ');
  if (planChanged) {
    invalidate(ctx, run, 'design', reasons);
    invalidate(ctx, run, 'plan', reasons);
    run.phase = 'DISCUSS';
  } else {
    invalidate(ctx, run, 'design', reasons);
    run.phase = 'DESIGN';
  }
  saveRun(ctx, run);
  appendEvent(ctx, run, {
    type: planChanged ? 'REQUIREMENTS_UPDATED' : 'DESIGN_UPDATED',
    status: run.phase,
    summary: planChanged
      ? '승인 이후 요구사항이 바뀌어 기획·설계 승인을 무효화했다.'
      : '승인 이후 설계 또는 작업 목록이 바뀌어 설계 승인을 무효화했다.',
    reason: reasons,
    nextAction: '바뀐 내용을 사용자와 확인한 뒤 다시 승인받는다.',
  });
  return drift;
}

// ---------- 명령: new ----------

function renderTemplate(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (all, name) => (name in vars ? vars[name] : all));
}

export async function cmdNew(ctx, opts) {
  const values = requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  if (!title || title.length > 200) throw usageError('--title "<기능 이름>" 이 필요하다 (200자 이하).');
  return withLock(ctx, 'new', async () => {
    const featureId = opts.feature ? assertId('feature', opts.feature) : nextFeatureId(ctx);
    const existing = activeRunForFeature(ctx, featureId);
    if (existing) throw new WorkflowError('RUN_EXISTS', `${featureId} 는 이미 진행 중이다 (${existing.runId}, ${existing.phase}).`);
    const runId = nextRunId(ctx);
    const fdir = featureDir(ctx, featureId);
    const templateDir = path.join(ctx.workflowRoot, 'templates', values.AIWF_DOC_LANGUAGE);
    if (!fs.existsSync(templateDir)) throw blocked('TEMPLATES_MISSING', `템플릿 폴더 없음: templates/${values.AIWF_DOC_LANGUAGE}`);
    const vars = {
      FEATURE_ID: featureId,
      RUN_ID: runId,
      TITLE: title,
      PROJECT_NAME: values.AIWF_PROJECT_NAME,
      DATE: ctx.now().slice(0, 10),
    };
    const created = [];
    for (const name of FEATURE_FILES) {
      const target = path.join(fdir, name);
      if (fs.existsSync(target)) {
        if (fs.lstatSync(target).isSymbolicLink()) throw blocked('SYMLINK_REJECTED', `symlink 거부: features/${featureId}/${name}`);
        continue;
      }
      atomicWriteFile(target, renderTemplate(fs.readFileSync(path.join(templateDir, name), 'utf8'), vars));
      created.push(name);
    }
    const run = {
      schemaVersion: 1,
      runId,
      featureId,
      title,
      phase: 'DISCUSS',
      createdAt: ctx.now(),
      approvalSeq: 0,
      approvals: { plan: null, design: null },
      approvalHistory: [],
      tasks: {},
    };
    saveRun(ctx, run);
    appendEvent(ctx, run, {
      type: 'RUN_CREATED',
      status: run.phase,
      summary: `기능 "${title}" 시작. 생성 문서: ${created.join(', ') || '없음(기존 문서 유지)'}`,
      nextAction: '사용자와 요구사항을 논의하고 decisions.md·requirements.md 를 채운다.',
    });
    return {
      ok: true,
      message: `${featureId} / ${runId} 생성 — 단계: ${PHASE_LABELS.DISCUSS}\n문서: .ai-workflow/features/${featureId}/ (${created.join(', ') || '기존 유지'})`,
    };
  });
}

// ---------- 명령: approve ----------

function approvalText(opts) {
  const text = typeof opts['approval-text'] === 'string' ? opts['approval-text'].trim() : '';
  if (opts['user-confirmed'] !== true || text.length < 2) {
    throw usageError('approve 는 사용자가 대화에서 진행을 확인한 뒤에만 실행한다. --user-confirmed 와 --approval-text "<사용자 답변 원문>" 이 필요하다.');
  }
  return text;
}

function approvePlan(ctx, run, text) {
  if (run.phase !== 'DISCUSS') throw blocked('WRONG_PHASE', `기획 승인은 논의 단계에서만 한다 (현재 ${run.phase}).`);
  const req = readRequirements(ctx, run.featureId);
  if (!req.version) throw blocked('REQUIREMENTS_VERSION_MISSING', 'requirements.md 에 "명세 버전:" 값이 없다.');
  if (req.requirementIds.length === 0) throw blocked('REQUIREMENTS_EMPTY', 'requirements.md 에 REQ-### 항목이 없다.');
  if (req.openQuestions.length) throw blocked('OPEN_QUESTIONS', `미결 질문이 남아 있다: ${req.openQuestions.join(', ')}. 해결해 decisions.md 에 기록하고 목록에서 지운다.`);
  run.approvalSeq += 1;
  run.approvals.plan = {
    seq: run.approvalSeq,
    approvedAt: ctx.now(),
    approvalText: redact(text).slice(0, 2000),
    hash: req.hash,
    version: req.version,
    requirementIds: req.requirementIds,
  };
  run.phase = 'DESIGN';
  return `기획 승인 #${run.approvalSeq}: 명세 버전 ${req.version}, 요구사항 ${req.requirementIds.length}개 (sha256 ${req.hash.slice(0, 12)})`;
}

function approveDesign(ctx, run, text) {
  if (run.phase !== 'DESIGN') throw blocked('WRONG_PHASE', `설계 승인은 설계 단계에서만 한다 (현재 ${run.phase}).`);
  const plan = run.approvals.plan;
  if (!plan) throw blocked('PLAN_NOT_APPROVED', '기획(요구사항) 승인이 먼저 필요하다.');
  const design = readDesign(ctx, run.featureId);
  if (!design.version) throw blocked('DESIGN_VERSION_MISSING', 'design.md 에 "설계 버전:" 값이 없다.');
  if (design.openQuestions.length) throw blocked('OPEN_QUESTIONS', `설계 미결 질문이 남아 있다: ${design.openQuestions.join(', ')}`);
  const data = readJson(path.join(featureDir(ctx, run.featureId), 'tasks.json'));
  const { tasks, order } = validateTaskList(data, { requirementIds: plan.requirementIds });
  run.approvalSeq += 1;
  run.approvals.design = {
    seq: run.approvalSeq,
    approvedAt: ctx.now(),
    approvalText: redact(text).slice(0, 2000),
    hash: design.hash,
    version: design.version,
    tasksHash: hashJson(tasks),
    order,
    tasks: Object.fromEntries(tasks.map((t) => [t.id, { hash: hashJson(t), contract: t }])),
  };
  // 새 설계 승인에서는 이전 승인의 작업 결과를 인정하지 않는다 (이력은 보존).
  for (const [id, state] of Object.entries(run.tasks)) state.status = order.includes(id) ? 'PENDING' : 'NOT_IN_APPROVAL';
  for (const id of order) run.tasks[id] ??= { status: 'PENDING', attempts: [], reviews: [] };
  run.phase = 'DEVELOP';
  return `설계 승인 #${run.approvalSeq}: 설계 버전 ${design.version}, 작업 ${tasks.length}개 (순서 ${order.join(' → ')})`;
}

export async function cmdApprove(ctx, opts) {
  const text = approvalText(opts);
  if (!['plan', 'design'].includes(opts.phase)) throw usageError('--phase plan|design 이 필요하다.');
  requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  return withLock(ctx, 'approve', async () => {
    const run = resolveRun(ctx, opts);
    const drift = syncApprovals(ctx, run);
    if (drift.length) ctx.out(`[알림] 승인 이후 문서 변경 감지 — 승인을 되돌렸다: ${drift.map((d) => d.reason).join(', ')}`);
    const summary = opts.phase === 'plan' ? approvePlan(ctx, run, text) : approveDesign(ctx, run, text);
    saveRun(ctx, run);
    appendEvent(ctx, run, {
      type: opts.phase === 'plan' ? 'REQUIREMENTS_CONFIRMED' : 'DESIGN_CONFIRMED',
      status: run.phase,
      actor: 'master',
      summary,
      reason: `사용자 답변: ${text.slice(0, 300)}`,
      nextAction: opts.phase === 'plan' ? '설계 문서와 작업 목록을 작성한다.' : '작업 순서대로 개발한다.',
    });
    return { ok: true, message: `${summary}\n다음 단계: ${PHASE_LABELS[run.phase]}` };
  });
}

// ---------- 명령: status ----------

function describeRun(ctx, run) {
  const lines = [`${run.featureId} ${run.runId} "${run.title}" — ${PHASE_LABELS[run.phase] ?? run.phase}`];
  const { plan, design } = run.approvals;
  lines.push(`  기획 승인: ${plan ? `#${plan.seq} 명세 ${plan.version} (${plan.approvedAt})` : '없음'}`);
  lines.push(`  설계 승인: ${design ? `#${design.seq} 설계 ${design.version}, 작업 ${design.order.length}개` : '없음'}`);
  for (const d of detectApprovalDrift(ctx, run)) {
    lines.push(`  ! 승인 이후 변경: ${d.reason} — 다음 명령에서 ${d.approval === 'plan' ? '기획·설계' : '설계'} 승인이 무효화된다`);
  }
  if (design) {
    for (const id of design.order) lines.push(`  ${id} ${run.tasks[id]?.status ?? 'PENDING'} — ${design.tasks[id].contract.title}`);
  }
  return lines;
}

export async function cmdStatus(ctx, opts) {
  const config = ctx.config;
  const ignore = checkEnvIgnored(ctx);
  const lines = [];
  lines.push(`프로젝트: ${config.values.AIWF_PROJECT_NAME || '(미설정)'}  루트: ${ctx.projectRoot}`);
  lines.push(`설정(.ai-workflow/.env): ${!config.exists ? '없음 — init 필요' : config.errors.length ? `오류 ${config.errors.length}건 — init 필요` : '정상'}`);
  for (const e of config.errors) lines.push(`  - ${e.key}: ${e.message}`);
  lines.push(`git 제외: ${describeIgnore(ignore.state)}`);
  lines.push(`Slack 알림: ${config.values.AIWF_SLACK_ENABLED === 'true' ? '사용' : '사용 안 함'}`);
  const lock = inspectLock(ctx);
  if (lock) lines.push(`잠금: ${lock.owner?.command ?? '?'} (pid ${lock.owner?.pid ?? '?'}, ${lock.reason})`);
  const runs = opts.run || opts.feature ? [resolveRun(ctx, opts)] : listRuns(ctx).filter((r) => opts.all || r.phase !== 'DONE');
  if (runs.length === 0) lines.push('진행 중인 기능 없음. `new --title "..."` 으로 시작한다.');
  for (const run of runs) lines.push('', ...describeRun(ctx, run));
  if (opts.json) {
    return { ok: true, message: JSON.stringify({ config: { exists: config.exists, errors: config.errors }, envIgnore: ignore.state, lock, runs }, null, 2) };
  }
  return { ok: true, message: lines.join('\n') };
}

// ---------- 명령: unlock ----------

export async function cmdUnlock(ctx, opts) {
  if (opts.stale !== true) throw usageError('unlock 은 --stale --reason "<확인 내용>" 로만 쓴다.');
  const record = breakStaleLock(ctx, { reason: opts.reason, forceUnverified: opts['force-unverified'] === true });
  return { ok: true, message: `잠금 보관 처리: ${record.archivedTo}` };
}
