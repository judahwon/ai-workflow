// 검수 단계: 구현한 세션과 다른 모델(Codex CLI, 읽기 전용 샌드박스)이 요구사항·설계 대비 변경을 검토한다.
// - review        : Codex 를 실행하고 구조화된 결과(JSON)를 검증해 기록한다. 승인이면 확정(검증) 단계로 간다.
// - review-accept : 지적이 남았거나 Codex 를 쓸 수 없을 때, 사용자 허락으로 검수를 넘긴다.
// 모델 출력은 기록·표시만 하고 명령으로 실행하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { blocked, isValidId, writeJsonAtomic, atomicWriteFile, redact } from './util.mjs';
import { withLock } from './lock.mjs';
import { appendEvent, runDir } from './events.mjs';
import { requireValidConfig, requireEnvIgnored } from './config.mjs';
import { resolveRun, saveRun, syncApprovals, PHASE_LABELS } from './runs.mjs';
import { featureDir } from './documents.mjs';
import { buildInvocation } from './process.mjs';
import { workspaceFingerprint, diffSince } from './scope.mjs';
import { requireApproval } from './verify.mjs';

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

function parseJsonLines(text) {
  const items = [];
  let invalid = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { items.push(JSON.parse(line)); } catch { invalid++; }
  }
  return { items, invalid };
}

// codex exec --json 출력에서 마지막 에이전트 메시지와 파일 변경 시도를 찾는다.
export function parseCodexStream(stdout) {
  const { items } = parseJsonLines(stdout);
  const messages = [];
  let fileChanges = 0;
  let errors = 0;
  for (const it of items) {
    const item = it?.item;
    if (it?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') messages.push(item.text);
    if (it?.msg?.type === 'agent_message' && typeof it.msg.message === 'string') messages.push(it.msg.message);
    if (item?.type === 'file_change' || it?.msg?.type === 'patch_apply_begin') fileChanges++;
    if (it?.type === 'error' || it?.type === 'turn.failed' || it?.msg?.type === 'error') errors++;
  }
  return { lastMessage: messages.at(-1) ?? null, fileChanges, errors };
}

const VERDICTS = ['APPROVED', 'CHANGES_REQUESTED'];
const CHECK_STATUS = ['MET', 'NOT_MET', 'UNVERIFIED'];
const SEVERITIES = ['high', 'medium', 'low'];

export function parseReview(text, requirementIds) {
  let data;
  try {
    const t = String(text ?? '').trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(t);
    data = JSON.parse(fenced ? fenced[1] : t);
  } catch {
    return { ok: false, code: 'REVIEW_NOT_JSON' };
  }
  if (!data || typeof data !== 'object' || !VERDICTS.includes(data.verdict) || typeof data.summary !== 'string'
    || !Array.isArray(data.findings) || !Array.isArray(data.requirementChecks)) {
    return { ok: false, code: 'REVIEW_SCHEMA' };
  }
  for (const f of data.findings) {
    if (!f || typeof f.message !== 'string' || !SEVERITIES.includes(f.severity)) return { ok: false, code: 'REVIEW_FINDING_SCHEMA' };
  }
  const checks = new Map();
  for (const c of data.requirementChecks) {
    if (!c || !isValidId('requirement', c.requirementId) || !CHECK_STATUS.includes(c.status) || typeof c.evidence !== 'string') {
      return { ok: false, code: 'REVIEW_CHECK_SCHEMA' };
    }
    checks.set(c.requirementId, c.status);
  }
  const missing = requirementIds.filter((r) => !checks.has(r));
  if (missing.length) return { ok: false, code: 'REVIEW_MISSING_REQUIREMENT', missing };
  if (data.verdict === 'APPROVED' && ([...checks.values()].some((s) => s !== 'MET') || data.findings.some((f) => f.severity === 'high'))) {
    return { ok: false, code: 'REVIEW_INCONSISTENT' };
  }
  return {
    ok: true,
    review: {
      verdict: data.verdict,
      summary: redact(data.summary).slice(0, 4000),
      findings: data.findings.slice(0, 100).map((f) => ({
        severity: f.severity,
        file: typeof f.file === 'string' ? f.file.slice(0, 240) : null,
        line: Number.isInteger(f.line) ? f.line : null,
        message: redact(f.message).slice(0, 2000),
      })),
      requirementChecks: data.requirementChecks.map((c) => ({ requirementId: c.requirementId, status: c.status, evidence: redact(c.evidence).slice(0, 2000) })),
    },
  };
}

// 작업들이 바꾼 파일과 비교 기준(가장 이른 작업 시작 커밋).
export function featureChanges(run) {
  const files = new Set();
  let base = null;
  let earliest = null;
  for (const id of run.approvals.design?.order ?? []) {
    for (const attempt of run.tasks[id]?.attempts ?? []) {
      for (const f of attempt.changedFiles ?? []) files.add(f);
      for (const f of attempt.extraApproved?.files ?? []) files.add(f);
      if (attempt.baseline && (!earliest || attempt.startedAt < earliest)) {
        earliest = attempt.startedAt;
        base = attempt.baseline.base;
      }
    }
  }
  return { files: [...files].sort(), base };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return '(없음)'; }
}

export function buildReviewPrompt(ctx, run, { files, diff }) {
  const fdir = featureDir(ctx, run.featureId);
  const values = ctx.config.values;
  const english = values.AIWF_DOC_LANGUAGE === 'en';
  const tasks = (run.approvals.design.order ?? []).map((id) => run.approvals.design.tasks[id].contract);
  const reqIds = run.approvals.plan.requirementIds;
  return [
    english
      ? `You are an independent code reviewer for the project "${values.AIWF_PROJECT_NAME}". Another agent implemented the feature below. Review it critically. Do not modify any file.`
      : `너는 "${values.AIWF_PROJECT_NAME}" 프로젝트의 독립 코드 검수자다. 다른 에이전트가 아래 기능을 구현했다. 비판적으로 검토한다. 파일을 수정하지 않는다.`,
    english
      ? 'Read the changed files in the repository as needed. Check every requirement (REQ) against the implementation, look for bugs, missing edge cases, security issues and changes outside the design.'
      : '필요하면 저장소의 변경 파일을 직접 읽는다. 요구사항(REQ)마다 구현을 확인하고, 버그·빠진 예외 처리·보안 문제·설계 밖 변경을 찾는다.',
    '',
    `# ${run.featureId} ${run.title}`,
    '',
    '## requirements.md',
    readText(path.join(fdir, 'requirements.md')),
    '',
    '## design.md',
    readText(path.join(fdir, 'design.md')),
    '',
    '## tasks (approved contracts)',
    JSON.stringify(tasks, null, 2),
    '',
    `## changed files (${files.length})`,
    ...files.map((f) => `- ${f}`),
    '',
    '## diff',
    diff || '(diff 없음 — 파일을 직접 읽는다)',
    '',
    '## output',
    english
      ? 'Reply with ONLY one JSON object (no prose, no code fence) in this shape:'
      : '아래 형식의 JSON 객체 하나만 답한다 (설명문·코드 펜스 없이). 문자열 값은 한국어로 쓴다:',
    JSON.stringify({
      verdict: 'APPROVED | CHANGES_REQUESTED',
      summary: '...',
      findings: [{ severity: 'high | medium | low', file: 'path/or/null', line: 0, message: '...' }],
      requirementChecks: reqIds.map((r) => ({ requirementId: r, status: 'MET | NOT_MET | UNVERIFIED', evidence: '...' })),
    }, null, 2),
    english
      ? 'APPROVED only if every requirement is MET and there is no high severity finding.'
      : '모든 요구사항이 MET 이고 high 지적이 없을 때만 APPROVED 다.',
  ].join('\n');
}

function interpret(proc, requirementIds) {
  if (proc.spawnError) {
    return proc.spawnError.code === 'ENOENT'
      ? { ok: false, code: 'CODEX_NOT_FOUND', message: 'codex 실행 파일을 찾지 못했다. .env 의 AIWF_CODEX_BIN 을 확인한다.' }
      : { ok: false, code: 'SPAWN_FAILED', message: `codex 시작 실패 (${proc.spawnError.code}).` };
  }
  if (proc.timedOut) return { ok: false, code: 'TIMEOUT', message: '검수 시간 제한(30분) 초과.' };
  if (proc.outputLimitExceeded) return { ok: false, code: 'OUTPUT_LIMIT', message: '출력 크기 상한 초과.' };
  const parsed = parseCodexStream(proc.stdout);
  if (parsed.fileChanges > 0) return { ok: false, code: 'REVIEWER_ATTEMPTED_WRITE', message: '검수자가 파일 변경을 시도했다.' };
  if (proc.exitCode !== 0 || parsed.errors > 0) {
    const hint = /login|auth|credential|usage limit|rate limit|quota/i.test(`${proc.stdout}\n${proc.stderr}`) ? ' 인증·사용량 제한일 수 있다 (codex login status).' : '';
    return { ok: false, code: 'CODEX_ERROR', message: `codex 실행 오류 (exit ${proc.exitCode}).${hint}` };
  }
  const review = parseReview(parsed.lastMessage, requirementIds);
  if (!review.ok) return { ok: false, code: review.code, message: `구조화된 검수 결과를 확인할 수 없다 (${review.code}${review.missing ? `: ${review.missing.join(',')}` : ''}).` };
  return { ok: true, review: review.review };
}

export async function cmdReview(ctx, opts) {
  const values = requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  return withLock(ctx, 'review', async () => {
    const run = resolveRun(ctx, opts);
    const drift = syncApprovals(ctx, run);
    if (drift.length) throw blocked('APPROVAL_DRIFT', `승인 이후 문서가 바뀌어 승인을 되돌렸다 (${drift.map((d) => d.reason).join(', ')}).`);
    if (!['REVIEW', 'VERIFY'].includes(run.phase)) throw blocked('WRONG_PHASE', `검수는 모든 작업이 끝난 뒤에 한다 (현재 ${PHASE_LABELS[run.phase]}).`);
    const { files, base } = featureChanges(run);
    const diff = base && files.length ? diffSince(ctx, base, files) : '';
    const prompt = buildReviewPrompt(ctx, run, { files, diff });
    run.reviews ??= [];
    const seq = run.reviews.length + 1;
    const dir = path.join(runDir(ctx, run.runId), 'reviews');
    const name = `R${String(seq).padStart(3, '0')}`;
    atomicWriteFile(path.join(dir, `${name}-prompt.md`), prompt);
    const fingerprint = workspaceFingerprint(ctx);
    const invocation = buildInvocation(values.AIWF_CODEX_BIN, [
      'exec', '--sandbox', 'read-only', '--json', '--ignore-user-config', '--ephemeral', '--model', values.AIWF_REVIEW_MODEL, '-C', ctx.projectRoot, '-',
    ], { env: ctx.env, platform: ctx.platform });
    const proc = await ctx.runProcess({ ...invocation, cwd: ctx.projectRoot, env: ctx.env, input: prompt, timeoutMs: REVIEW_TIMEOUT_MS });
    const outcome = interpret(proc, run.approvals.plan.requirementIds);
    if (!outcome.ok) {
      appendEvent(ctx, run, { type: 'REVIEW_FAILED', status: run.phase, summary: `검수 실패: ${outcome.message}`, reason: outcome.code, nextAction: '원인을 해결해 다시 review 하거나, 사용자 허락으로 review-accept 한다.' });
      throw blocked(outcome.code, `${outcome.message} 사용자 허락이 있으면 review-accept 로 넘길 수 있다.`);
    }
    const review = outcome.review;
    const record = { seq, at: ctx.now(), requestedModel: values.AIWF_REVIEW_MODEL, fingerprint, base, files, ...review };
    writeJsonAtomic(path.join(dir, `${name}.json`), record);
    run.reviews.push({ seq, at: record.at, verdict: review.verdict, summary: review.summary.slice(0, 300), findings: review.findings.length, file: `runs/${run.runId}/reviews/${name}.json` });
    if (review.verdict === 'APPROVED') {
      run.reviewOutcome = { type: 'APPROVED', reviewSeq: seq, at: record.at, fingerprint };
      run.phase = 'VERIFY';
    } else {
      run.reviewOutcome = null;
      run.phase = 'REVIEW';
    }
    saveRun(ctx, run);
    appendEvent(ctx, run, {
      type: 'REVIEW_DONE', status: review.verdict, actor: 'reviewer',
      summary: `검수 ${name}: ${review.verdict} — ${review.summary.slice(0, 300)}`,
      reason: review.findings.length ? `지적 ${review.findings.length}건 (high ${review.findings.filter((f) => f.severity === 'high').length})` : null,
      evidencePaths: [`runs/${run.runId}/reviews/${name}.json`],
      nextAction: review.verdict === 'APPROVED' ? 'verify 로 검증한다.' : '지적을 사용자와 확인하고 task-reopen 으로 고치거나 review-accept 한다.',
    });
    const lines = [
      `검수 ${name} (요청 모델 ${values.AIWF_REVIEW_MODEL}, 실제 모델은 확인 불가): ${review.verdict}`,
      review.summary,
      '',
      '요구사항:',
      ...review.requirementChecks.map((c) => `  ${c.status.padEnd(10)} ${c.requirementId} — ${c.evidence.slice(0, 200)}`),
    ];
    if (review.findings.length) {
      lines.push('', '지적:');
      for (const f of review.findings) lines.push(`  [${f.severity}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.message}`);
    }
    lines.push('', `다음 단계: ${PHASE_LABELS[run.phase]}`);
    return { ok: review.verdict === 'APPROVED', message: lines.join('\n') };
  });
}

export async function cmdReviewAccept(ctx, opts) {
  const text = requireApproval(opts, 'review-accept');
  requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  return withLock(ctx, 'review-accept', async () => {
    const run = resolveRun(ctx, opts);
    const drift = syncApprovals(ctx, run);
    if (drift.length) throw blocked('APPROVAL_DRIFT', `승인 이후 문서가 바뀌어 승인을 되돌렸다 (${drift.map((d) => d.reason).join(', ')}).`);
    if (!['REVIEW', 'VERIFY'].includes(run.phase)) throw blocked('WRONG_PHASE', `검수 단계가 아니다 (현재 ${PHASE_LABELS[run.phase]}).`);
    const last = run.reviews?.at(-1) ?? null;
    run.reviewOutcome = { type: 'ACCEPTED', reviewSeq: last?.seq ?? null, at: ctx.now(), fingerprint: workspaceFingerprint(ctx), approvalText: text };
    run.phase = 'VERIFY';
    saveRun(ctx, run);
    appendEvent(ctx, run, {
      type: 'REVIEW_ACCEPTED', status: 'VERIFY', actor: 'master',
      summary: last ? `검수 R${String(last.seq).padStart(3, '0')} (${last.verdict}) 를 사용자 허락으로 넘김` : 'Codex 검수 없이 사용자 허락으로 넘김',
      reason: `사용자 답변: ${text.slice(0, 300)}`,
      nextAction: 'verify 로 검증한다.',
    });
    return { ok: true, message: `검수 넘김 기록. 다음 단계: ${PHASE_LABELS.VERIFY}` };
  });
}
