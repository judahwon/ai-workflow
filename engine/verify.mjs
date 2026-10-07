// 검증·확정 단계.
// - checks-set : 프로젝트 검사(checks.json)를 사용자 승인과 함께 저장한다. 승인 뒤 파일이 바뀌면 검증이 막힌다.
// - verify     : 프로젝트 검사 + 설계 승인된 기능 테스트를 실행하고 결과·로그·작업 트리 지문을 남긴다.
// - test-confirm: 사람이 확인하는 manual 테스트의 통과를 사용자 답변과 함께 기록한다.
// - confirm    : 검수·검증 결과가 지금 코드에 대한 것이고 필수 항목이 모두 통과했을 때 사용자 확정을 기록한다 → 문서 단계.
import fs from 'node:fs';
import path from 'node:path';
import { blocked, usageError, assertId, readJson, writeJsonAtomic, atomicWriteFile, redact } from './util.mjs';
import { withLock } from './lock.mjs';
import { appendEvent, runDir } from './events.mjs';
import { requireValidConfig, requireEnvIgnored } from './config.mjs';
import { resolveRun, saveRun, syncApprovals, driftBlocked, PHASE_LABELS } from './runs.mjs';
import { verifyFailedDecision, confirmReadyDecision } from './decisions.mjs';
import { escalate, isAutonomous, autonomyLimits } from './autonomy.mjs';
import { CHECKS_FILE, checksPath, checksContentHash, validateChecks, loadChecks } from './testplan.mjs';
import { runCommand, runHttp, runBrowser } from './runners.mjs';
import { workspaceFingerprint, captureBaseline } from './scope.mjs';

export function requireApproval(opts, what = '이 명령') {
  const text = typeof opts['approval-text'] === 'string' ? opts['approval-text'].trim() : '';
  if (opts['user-confirmed'] !== true || text.length < 2) {
    throw usageError(`${what}은 사용자가 대화에서 확인한 뒤에만 실행한다. --approval-text "<사용자 답변 원문>" --user-confirmed 가 필요하다.`);
  }
  return redact(text).slice(0, 2000);
}

function requireRunWithoutDrift(ctx, opts, phases) {
  const run = resolveRun(ctx, opts);
  const drift = syncApprovals(ctx, run);
  if (drift.length) {
    throw driftBlocked(ctx, run, drift, ` 현재 단계: ${PHASE_LABELS[run.phase]}`);
  }
  if (!phases.includes(run.phase)) {
    throw blocked('WRONG_PHASE', `이 명령은 ${phases.map((p) => PHASE_LABELS[p]).join(' / ')} 단계에서만 쓴다 (현재 ${PHASE_LABELS[run.phase] ?? run.phase}).`);
  }
  return run;
}

// ---------- checks-set ----------

export async function cmdChecksSet(ctx, opts) {
  const text = requireApproval(opts, 'checks-set');
  return withLock(ctx, 'checks-set', async () => {
    const file = checksPath(ctx);
    let source;
    if (opts.from) {
      const from = path.resolve(ctx.cwd, opts.from);
      if (!fs.existsSync(from)) throw usageError(`--from 파일이 없다: ${opts.from}`);
      source = readJson(from);
    } else {
      if (!fs.existsSync(file)) throw usageError(`${CHECKS_FILE} 이 없다. --from <JSON 파일> 로 내용을 준다.`);
      source = readJson(file);
    }
    if (source && typeof source === 'object') delete source.approval;
    const valid = validateChecks(source);
    const data = {
      schemaVersion: 1,
      origins: valid.origins,
      checks: source.checks ?? [],
      approval: { approvalText: text, approvedAt: ctx.now(), hash: null },
    };
    data.approval.hash = checksContentHash(validateChecks(data));
    writeJsonAtomic(file, data);
    const lines = [`${CHECKS_FILE} 저장·승인: 검사 ${valid.checks.length}개, 서버 주소 ${Object.keys(valid.origins).length}개`];
    for (const c of valid.checks) lines.push(`  - ${c.id}: ${c.command}${c.cwd !== '.' ? ` (cwd ${c.cwd})` : ''}${c.required ? '' : ' [선택]'}`);
    for (const [name, url] of Object.entries(valid.origins)) lines.push(`  - origin ${name}: ${url}`);
    return { ok: true, message: lines.join('\n') };
  });
}

// ---------- verify ----------

function plannedItems(ctx, run, checks) {
  const items = checks.checks.map((c) => ({ id: c.id, source: 'check', kind: 'command', title: c.title, required: c.required, def: c }));
  for (const t of run.approvals.design.tests ?? []) items.push({ id: t.id, source: 'test', kind: t.kind, title: t.title, required: t.required !== false, def: t });
  return items;
}

async function runItem(ctx, item, evidenceDir, checks) {
  const values = ctx.config.values;
  const io = {
    projectRoot: ctx.projectRoot,
    runProcess: ctx.runProcess,
    env: ctx.env,
    origins: checks.origins,
    fetchImpl: ctx.fetchImpl,
    playwright: ctx.playwright,
    modulePath: values.AIWF_PLAYWRIGHT_MODULE || null,
    channel: values.AIWF_BROWSER_CHANNEL || null,
    evidenceDir,
  };
  try {
    if (item.kind === 'command') return await runCommand(item.def, io);
    if (item.kind === 'http') return await runHttp(item.def, io);
    if (item.kind === 'browser') return await runBrowser(item.def, io);
  } catch (e) {
    return { status: 'BLOCKED', code: 'RUNNER_ERROR', message: `실행기 오류 (${e?.code ?? e?.name ?? 'Error'}).`, log: '', actual: null };
  }
  return { status: 'BLOCKED', code: 'UNSUPPORTED', message: `지원하지 않는 종류 ${item.kind}` };
}

function manualStatus(run, testId, fingerprint) {
  const confirmation = run.manualConfirmations?.[testId];
  if (!confirmation) return { status: 'MANUAL', code: 'WAITING', message: '사람 확인 대기 (test-confirm)' };
  if (fingerprint && confirmation.fingerprint !== fingerprint) return { status: 'MANUAL', code: 'STALE', message: '확인 이후 코드가 바뀌어 다시 확인이 필요하다' };
  return { status: 'PASS', code: 'CONFIRMED', message: `사용자 확인 (${confirmation.confirmedAt})` };
}

export async function cmdVerify(ctx, opts) {
  requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  const only = opts.only ?? [];
  return withLock(ctx, 'verify', async () => {
    const run = requireRunWithoutDrift(ctx, opts, ['DEVELOP', 'REVIEW', 'VERIFY']);
    const checks = loadChecks(ctx);
    if (checks.exists && !checks.approved) {
      throw blocked('CHECKS_NOT_APPROVED', `${CHECKS_FILE} 이 승인되지 않았거나 승인 뒤 바뀌었다${checks.error ? ` (${checks.error})` : ''}. 내용을 사용자에게 보여주고 checks-set 으로 승인받는다.`);
    }
    let items = plannedItems(ctx, run, checks);
    const unknown = only.filter((id) => !items.some((i) => i.id === id));
    if (unknown.length) throw usageError(`--only 에 없는 항목: ${unknown.join(', ')} (가능: ${items.map((i) => i.id).join(', ')})`);
    if (only.length) items = items.filter((i) => only.includes(i.id));
    const fingerprint = workspaceFingerprint(ctx);
    run.verifications ??= [];
    const seq = run.verifications.length + 1;
    const dir = path.join(runDir(ctx, run.runId), 'verify', `V${String(seq).padStart(3, '0')}`);
    const results = [];
    for (const item of items) {
      const started = Date.now();
      const evidenceDir = path.join(dir, item.id);
      const r = item.kind === 'manual' ? manualStatus(run, item.id, fingerprint) : await runItem(ctx, item, evidenceDir, checks);
      let logPath = null;
      if (r.log) {
        atomicWriteFile(path.join(evidenceDir, 'log.txt'), r.log);
        logPath = path.relative(ctx.workflowRoot, path.join(evidenceDir, 'log.txt')).split(path.sep).join('/');
      }
      results.push({ id: item.id, source: item.source, kind: item.kind, title: item.title, required: item.required, status: r.status, code: r.code, message: r.message, durationMs: Date.now() - started, logPath, actual: r.actual ?? null });
    }
    const requiredBad = results.filter((r) => r.required && r.status !== 'PASS');
    const verification = {
      seq, at: ctx.now(), phase: run.phase, partial: only.length > 0, fingerprint, checksHash: checks.exists ? checks.approval?.hash ?? null : null,
      passed: requiredBad.length === 0, results: results.map(({ actual, ...rest }) => rest),
    };
    run.verifications.push(verification);
    writeJsonAtomic(path.join(dir, 'result.json'), { ...verification, results });
    saveRun(ctx, run);
    const count = (s) => results.filter((r) => r.status === s).length;
    const summary = `검증 V${seq}${verification.partial ? ' (일부)' : ''}: 통과 ${count('PASS')}, 실패 ${count('FAIL')}, 실행 불가 ${count('BLOCKED')}, 사람 확인 대기 ${count('MANUAL')}`;
    const failedIds = requiredBad.filter((r) => r.status !== 'MANUAL').map((r) => r.id);
    const manualIds = requiredBad.filter((r) => r.status === 'MANUAL').map((r) => r.id);
    let decision = null;
    if (!verification.passed) decision = verifyFailedDecision(ctx.config.values.AIWF_DOC_LANGUAGE, { featureId: run.featureId, failed: failedIds, manual: manualIds });
    else if (run.phase === 'VERIFY' && !verification.partial && confirmationProblems(ctx, run).problems.length === 0) decision = confirmReadyDecision(ctx.config.values.AIWF_DOC_LANGUAGE, { featureId: run.featureId });
    const eventFields = {
      data: { passed: count('PASS'), bad: requiredBad.length, badIds: requiredBad.map((r) => r.id), partial: verification.partial },
      status: verification.passed ? 'PASS' : 'FAIL',
      reason: requiredBad.length ? requiredBad.map((r) => `${r.id} ${r.status} ${r.code}`).join(', ').slice(0, 900) : null,
      evidencePaths: results.map((r) => r.logPath).filter(Boolean),
    };
    if (isAutonomous(run) && run.phase === 'VERIFY' && !verification.partial) {
      const full = run.verifications.filter((v) => !v.partial);
      let streak = 0;
      for (let i = full.length - 1; i >= 0 && !full[i].passed; i--) streak++;
      const max = autonomyLimits(ctx).maxVerifyFailures;
      const onlyManual = !verification.passed && failedIds.length === 0 && manualIds.length > 0;
      const ready = verification.passed && decision;
      if (ready || onlyManual) {
        // 끝났다: 보고하고 사용자 확정(과 사람이 볼 테스트)을 요청한다.
        const tasks = run.approvals.design?.order.length ?? 0;
        const review = run.reviews?.at(-1);
        const reportLine = `설계·개발·검수·검증 완료 — 작업 ${tasks}개, 검수 ${review ? `R${String(review.seq).padStart(3, '0')} ${review.verdict}` : '사용자 허락'}, 자동 검증 통과 ${count('PASS')}건${manualIds.length ? `, 사람 확인 필요 ${manualIds.length}건 (${manualIds.join(', ')})` : ''}.`;
        escalate(ctx, run, { kind: 'confirm', type: 'VERIFY_DONE', summary: reportLine, decision, fields: eventFields });
        return { ok: verification.passed, message: [summary, ...resultLines(results), reportLine, '자율 진행: 사용자를 불렀다 (확정 요청).'].join('\n'), decision };
      }
      if (!verification.passed && streak >= max) {
        escalate(ctx, run, { kind: 'limit', type: 'VERIFY_DONE', summary: `검증이 연속 ${streak}번 실패했다 (상한 ${max}): ${failedIds.join(', ')}`, decision, fields: eventFields });
        return { ok: false, message: [summary, ...resultLines(results), `자율 진행: 연속 실패 상한(${max})을 넘어 사용자를 불렀다.`].join('\n'), decision };
      }
      if (!verification.passed) decision = null;
    }
    appendEvent(ctx, run, {
      type: 'VERIFY_DONE',
      data: { passed: count('PASS'), bad: requiredBad.length, badIds: requiredBad.map((r) => r.id), partial: verification.partial },
      decision,
      status: verification.passed ? 'PASS' : 'FAIL',
      summary,
      reason: requiredBad.length ? requiredBad.map((r) => `${r.id} ${r.status} ${r.code}`).join(', ').slice(0, 900) : null,
      evidencePaths: results.map((r) => r.logPath).filter(Boolean),
      nextAction: verification.passed ? (run.phase === 'VERIFY' ? '사용자에게 결과를 보여주고 confirm 으로 확정받는다.' : '검수 단계로 진행한다.') : '실패 원인을 고치거나 사용자와 상의한다.',
    });
    const lines = [summary, ...resultLines(results)];
    if (!fingerprint) lines.push('[주의] git 저장소가 아니라 결과가 지금 코드에 대한 것인지 확인하지 못한다.');
    return { ok: verification.passed, message: lines.join('\n'), decision };
  });
}

function resultLines(results) {
  return results.map((r) => `  ${r.status.padEnd(7)} ${r.id} ${r.title}${r.required ? '' : ' [선택]'} — ${r.message}${r.logPath ? `  (로그 .ai-workflow/${r.logPath})` : ''}`);
}

// ---------- test-confirm ----------

export async function cmdTestConfirm(ctx, opts) {
  const text = requireApproval(opts, 'test-confirm');
  const testId = assertId('test', opts.test);
  return withLock(ctx, 'test-confirm', async () => {
    const run = requireRunWithoutDrift(ctx, opts, ['VERIFY']);
    const test = (run.approvals.design.tests ?? []).find((t) => t.id === testId);
    if (!test) throw blocked('TEST_NOT_FOUND', `${testId} 는 승인된 테스트에 없다.`);
    if (test.kind !== 'manual') throw blocked('NOT_MANUAL', `${testId} 는 ${test.kind} 테스트다. verify 로 실행한다.`);
    run.manualConfirmations ??= {};
    run.manualConfirmations[testId] = { approvalText: text, confirmedAt: ctx.now(), fingerprint: workspaceFingerprint(ctx) };
    run.waiting = null; // 사용자가 돌아와 답했다 (자율 진행 대기 해제)
    saveRun(ctx, run);
    appendEvent(ctx, run, { type: 'MANUAL_TEST_CONFIRMED', testId, status: 'PASS', actor: 'master', summary: `${testId} ${test.title} 사용자 확인`, reason: `사용자 답변: ${text.slice(0, 300)}` });
    return { ok: true, message: `${testId} 사용자 확인 기록. verify 를 다시 실행하면 통과로 반영된다.` };
  });
}

// ---------- confirm ----------

export function confirmationProblems(ctx, run) {
  const problems = [];
  const fingerprint = workspaceFingerprint(ctx);
  const outcome = run.reviewOutcome;
  if (!outcome) problems.push('검수 결과가 없다 (review 통과 또는 review-accept 필요).');
  else if (fingerprint && outcome.fingerprint !== fingerprint) problems.push('검수 이후 코드가 바뀌었다. review 를 다시 하거나 사용자 허락으로 review-accept 한다.');
  const checks = loadChecks(ctx);
  if (checks.exists && !checks.approved) problems.push(`${CHECKS_FILE} 이 승인되지 않았거나 승인 뒤 바뀌었다.`);
  const latest = (run.verifications ?? []).filter((v) => !v.partial).at(-1);
  if (!latest) problems.push('전체 검증(verify) 기록이 없다.');
  else {
    if (latest.phase !== 'VERIFY') problems.push('확정 단계에서 실행한 전체 검증이 없다. verify 를 다시 실행한다.');
    if (fingerprint && latest.fingerprint !== fingerprint) problems.push('마지막 검증 이후 코드가 바뀌었다. verify 를 다시 실행한다.');
    if (checks.exists && latest.checksHash !== checks.approval?.hash) problems.push(`마지막 검증 이후 ${CHECKS_FILE} 이 바뀌었다.`);
    const expected = plannedItems(ctx, run, checks).filter((i) => i.required).map((i) => i.id);
    for (const id of expected) {
      const r = latest.results.find((x) => x.id === id);
      if (!r) problems.push(`${id}: 마지막 검증에 없다.`);
      else if (r.status !== 'PASS') problems.push(`${id}: ${r.status} (${r.message})`);
    }
  }
  return { problems, fingerprint };
}

export async function cmdConfirm(ctx, opts) {
  const text = requireApproval(opts, 'confirm');
  requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  return withLock(ctx, 'confirm', async () => {
    const run = requireRunWithoutDrift(ctx, opts, ['VERIFY']);
    const { problems, fingerprint } = confirmationProblems(ctx, run);
    if (problems.length) throw blocked('NOT_READY', ['확정할 수 없다:', ...problems.map((p) => `  - ${p}`)].join('\n'));
    const latest = run.verifications.filter((v) => !v.partial).at(-1);
    run.confirmation = { approvalText: text, confirmedAt: ctx.now(), fingerprint, verificationSeq: latest.seq };
    run.waiting = null;
    run.docs = { startedAt: ctx.now(), baseline: captureBaseline(ctx) };
    run.phase = 'DOCS';
    saveRun(ctx, run);
    appendEvent(ctx, run, {
      type: 'CONFIRMED', status: 'DOCS', actor: 'master',
      summary: `기능 확정 (검증 V${latest.seq} 기준)`,
      reason: `사용자 답변: ${text.slice(0, 300)}`,
      nextAction: `${ctx.config.values.AIWF_DOCS_DIR}/ 에 문서를 쓰고 docs-done 한다.`,
      data: { docsDir: ctx.config.values.AIWF_DOCS_DIR },
    });
    return { ok: true, message: `확정 기록 (검증 V${latest.seq}). 다음 단계: ${PHASE_LABELS.DOCS} — ${ctx.config.values.AIWF_DOCS_DIR}/ 아래 문서를 쓰고 docs-done 한다.` };
  });
}
