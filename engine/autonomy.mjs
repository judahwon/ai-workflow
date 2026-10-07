// 자율 진행. 사용자가 기획을 승인하면서 자율 진행을 맡기면, master(Claude Code 세션)가 설계·개발·검수·검증을
// 혼자 진행하고 사용자는 필요할 때만 부른다 (Slack 멘션).
// - 사용자를 부르는 경우(escalation): 권한 확인 대기, 진행할 수 없는 오류, 기획이 이상함, 재시도 상한 초과,
//   세션이 멈춤, 그리고 모두 끝나 확정을 요청할 때. 부르면 실행은 "사용자 대기" 상태가 되고 resume 으로 풀린다.
// - 허용 명령(.ai-workflow/autonomy.json): 사용자가 승인한 명령 접두사. 자율 진행 중에는 권한 확인 없이 실행된다.
//   엔진 명령은 --user-confirmed 가 없을 때만 자동 허용한다 (사용자 승인은 사용자가 있을 때만).
import fs from 'node:fs';
import path from 'node:path';
import { WorkflowError, blocked, usageError, readJson, writeJsonAtomic, hashJson, redact } from './util.mjs';
import { withLock } from './lock.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { listRuns, resolveRun, saveRun, PHASE_LABELS } from './runs.mjs';
import { requireApproval } from './verify.mjs';
import { loadChecks } from './testplan.mjs';

export const AUTONOMY_FILE = 'autonomy.json';
// master 가 혼자 진행하는 단계. 문서 단계는 사용자 확정 뒤 master 가 마무리한다.
export const AUTO_PHASES = ['DESIGN', 'DEVELOP', 'REVIEW', 'VERIFY', 'DOCS'];
export const ESCALATION_KINDS = ['permission', 'blocked', 'plan', 'limit', 'stalled', 'confirm', 'other'];
const MAX_STOP_BLOCKS = 3;

// ---------- 허용 명령 (autonomy.json) ----------

export function autonomyPath(ctx) {
  return path.join(ctx.workflowRoot, AUTONOMY_FILE);
}

// 따옴표 안을 지운 뒤 명령을 잇거나 바꾸는 셸 문자가 있는지 본다. 있으면 접두사 허용으로 통과시키지 않는다.
export function hasShellChaining(command) {
  const bare = String(command).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  return /[;&|`<>\r\n]|\$\(/.test(bare);
}

export function validateAutonomy(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw blocked('AUTONOMY_INVALID', 'autonomy.json 은 객체여야 한다.');
  const allow = Array.isArray(data.allow) ? data.allow : null;
  if (!allow) errors.push('allow 는 명령 접두사 배열이어야 한다');
  for (const [i, p] of (allow ?? []).entries()) {
    if (typeof p !== 'string' || !p.trim() || p.length > 200) errors.push(`allow[${i}]: 1~200자 문자열`);
    else if (p !== p.trim()) errors.push(`allow[${i}]: 앞뒤 공백 없이`);
    else if (hasShellChaining(p)) errors.push(`allow[${i}]: ; & | \` < > $( 같은 셸 연결 문자는 쓸 수 없다`);
  }
  if ((allow ?? []).length > 100) errors.push('allow 는 100개 이하');
  if (errors.length) throw blocked('AUTONOMY_INVALID', `autonomy.json 오류: ${errors.join('; ')}`);
  return { allow: [...new Set(allow)] };
}

// 반환: { exists, approved, allow, approval, error }
export function loadAutonomy(ctx) {
  const file = autonomyPath(ctx);
  if (!fs.existsSync(file)) return { exists: false, approved: false, allow: [], approval: null, error: null };
  try {
    const raw = readJson(file);
    const valid = validateAutonomy(raw);
    const approved = !!raw.approval && raw.approval.hash === hashJson(valid);
    return { exists: true, approved, ...valid, approval: raw.approval ?? null, error: null };
  } catch (e) {
    return { exists: true, approved: false, allow: [], approval: null, error: e.message };
  }
}

export async function cmdAutonomySet(ctx, opts) {
  const text = requireApproval(opts, 'autonomy-set');
  return withLock(ctx, 'autonomy-set', async () => {
    if (!opts.from) throw usageError('--from <JSON 파일> 로 허용 명령 목록을 준다.');
    const from = path.resolve(ctx.cwd, opts.from);
    if (!fs.existsSync(from)) throw usageError(`--from 파일이 없다: ${opts.from}`);
    const valid = validateAutonomy(readJson(from));
    writeJsonAtomic(autonomyPath(ctx), { schemaVersion: 1, ...valid, approval: { approvalText: redact(text).slice(0, 2000), approvedAt: ctx.now(), hash: hashJson(valid) } });
    return { ok: true, message: [`${AUTONOMY_FILE} 저장·승인: 허용 명령 ${valid.allow.length}개`, ...valid.allow.map((p) => `  - ${p}`)].join('\n') };
  });
}

// 허용 명령 후보. 사용자가 고른 것만 autonomy-set 으로 저장한다.
export async function cmdAutonomySuggest(ctx) {
  const candidates = [];
  const add = (prefix, why) => { if (!candidates.some((c) => c.prefix === prefix)) candidates.push({ prefix, why }); };
  for (const c of loadChecks(ctx).checks) add(c.command, `checks.json 검사 ${c.id}`);
  const pkgFile = path.join(ctx.projectRoot, 'package.json');
  if (fs.existsSync(pkgFile)) {
    const has = (f) => fs.existsSync(path.join(ctx.projectRoot, f));
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    let scripts = {};
    try { scripts = readJson(pkgFile).scripts ?? {}; } catch { /* package.json 을 못 읽으면 스크립트 후보 없음 */ }
    for (const name of ['test', 'lint', 'build', 'typecheck', 'type-check', 'check', 'format:check']) {
      if (scripts[name]) add(name === 'test' && pm === 'npm' ? 'npm test' : `${pm} ${pm === 'npm' ? 'run ' : ''}${name}`, `package.json 스크립트 ${name}`);
    }
  }
  for (const g of ['git status', 'git diff', 'git log', 'git show', 'git ls-files']) add(g, 'git 읽기');
  const current = loadAutonomy(ctx);
  return { ok: true, message: JSON.stringify({ current: current.exists ? { approved: current.approved, allow: current.allow } : null, candidates }, null, 2) };
}

function samePathPrefix(command, engineDir, platform) {
  const norm = (s) => (platform === 'win32' ? s.replace(/\\/g, '/').toLowerCase() : s);
  const cli = norm(path.join(engineDir, 'cli.mjs'));
  const m = /^node\s+(?:"([^"]+)"|(\S+))(?:\s|$)/.exec(command);
  return !!m && norm(m[1] ?? m[2]) === cli;
}

// 따옴표 밖에서 명령을 나눈다. pipes 가 false 면 ; && || 로, true 면 파이프(|)로. 따옴표가 닫히지 않으면 null.
export function splitCommands(command, { pipes = false } = {}) {
  const parts = [];
  let current = '';
  let quote = null;
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < s.length) current += s[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    const two = s.slice(i, i + 2);
    if (!pipes && (two === '&&' || two === '||')) { parts.push(current); current = ''; i++; continue; }
    if (!pipes && ch === ';') { parts.push(current); current = ''; continue; }
    if (pipes && ch === '|' && two !== '||') { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (quote) return null;
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

// 파이프 뒤에 와도 되는, 입력을 읽어 출력만 하는 명령.
const SAFE_FILTER = /^(?:grep|egrep|head|tail|sort|uniq|wc|findstr)(?:\s|$)/;

function unquote(value) {
  return value.replace(/^"(.*)"$|^'(.*)'$/, (_, a, b) => a ?? b);
}

// 파이프 없는 명령 하나. 2>&1 꼬리는 떼고 본다.
function stageAllowed(ctx, stage, autonomy) {
  const cmd = stage.replace(/\s+2>&1\s*$/, '').trim();
  if (!cmd || hasShellChaining(cmd)) return false;
  if (/^echo(?:\s|$)/.test(cmd)) return true;
  // 프로젝트 안으로 옮겨 가는 cd 는 무해하다.
  const cd = /^cd\s+("[^"]*"|'[^']*'|\S+)$/.exec(cmd);
  if (cd) {
    const target = path.resolve(ctx.projectRoot, unquote(cd[1]));
    const rel = path.relative(ctx.projectRoot, target);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }
  if (samePathPrefix(cmd, ctx.engineDir, ctx.platform)) return !/--user-confirmed\b/.test(cmd);
  if (!autonomy.approved) return false;
  return autonomy.allow.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `));
}

function pipelineAllowed(ctx, part, autonomy) {
  const stages = splitCommands(part, { pipes: true });
  if (!stages || stages.length === 0) return false;
  const [first, ...filters] = stages;
  return stageAllowed(ctx, first, autonomy)
    && filters.every((f) => SAFE_FILTER.test(f) && !hasShellChaining(f.replace(/\s+2>&1\s*$/, '')));
}

// 자율 진행 중 권한 없이 실행해도 되는 명령인가.
// ; && || 로 이은 명령은 하나하나가 모두 허용이어야 하고, 파이프 뒤에는 grep·head·tail 같은 출력 필터만 온다.
export function commandAllowed(ctx, command, autonomy = loadAutonomy(ctx)) {
  const parts = splitCommands(String(command ?? '').trim());
  if (!parts || parts.length === 0 || parts.length > 10) return false;
  return parts.every((part) => pipelineAllowed(ctx, part, autonomy));
}

// ---------- 자율 진행 상태 ----------

export function autonomyLimits(ctx) {
  const v = ctx.config.values;
  return {
    maxReviewRounds: Number(v.AIWF_AUTO_MAX_REVIEW_ROUNDS) || 3,
    maxVerifyFailures: Number(v.AIWF_AUTO_MAX_VERIFY_FAILURES) || 3,
  };
}

export function isAutonomous(run) {
  return run?.autonomy?.enabled === true;
}

// 지금 master 가 혼자 진행 중인 실행 (사용자 대기 중이 아닌 것). 여러 개면 가장 최근에 움직인 것.
export function activeAutonomousRun(ctx) {
  return listRuns(ctx)
    .filter((r) => isAutonomous(r) && AUTO_PHASES.includes(r.phase) && !r.waiting)
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
    .at(-1) ?? null;
}

export function autonomousRuns(ctx) {
  return listRuns(ctx).filter((r) => isAutonomous(r) && r.phase !== 'DONE');
}

// 사용자를 부른다. 잠금 안에서 run 을 고친 뒤 호출한다. 이벤트 하나로 Slack 멘션이 나간다.
export function escalate(ctx, run, { kind, summary, decision = null, type = 'ESCALATED', fields = {} }) {
  run.waiting = { kind, summary: redact(summary).slice(0, 500), since: ctx.now(), decisionId: decision?.id ?? null };
  saveRun(ctx, run);
  return appendEvent(ctx, run, {
    status: run.phase,
    summary,
    nextAction: '사용자가 Claude Code 로 돌아와 master 와 이야기한다. 답을 받으면 resume 한다.',
    ...fields,
    type,
    decision,
    escalation: { kind },
  });
}

function parseOptions(list) {
  return (list ?? []).map((item) => {
    const [label, ...rest] = String(item).split('::');
    if (!label.trim() || label.length > 40) throw usageError(`--option 은 "이름::설명" 형식이고 이름은 40자 이하다: ${JSON.stringify(item.slice(0, 40))}`);
    return { label: label.trim(), description: rest.join('::').trim() || label.trim(), command: '(사용자 답을 받아 진행)' };
  });
}

// master 가 사용자를 부를 때. 질문하고 멈추는 대신 이것을 쓴다.
export async function cmdEscalate(ctx, opts) {
  const kind = opts.kind ?? 'other';
  if (!ESCALATION_KINDS.includes(kind)) throw usageError(`--kind 는 ${ESCALATION_KINDS.join('|')} 중 하나다.`);
  const summary = typeof opts.summary === 'string' ? opts.summary.trim() : '';
  if (summary.length < 5) throw usageError('--summary "<무엇 때문에 사용자가 필요한지 한 줄>" 이 필요하다.');
  const options = parseOptions(opts.option);
  if (options.length === 1 || options.length > 4) throw usageError('--option 은 0개 또는 2~4개다.');
  return withLock(ctx, 'escalate', async () => {
    const run = resolveRun(ctx, opts);
    const decision = options.length ? { id: 'ESCALATION', header: '확인 필요', question: summary, options } : null;
    escalate(ctx, run, { kind, summary, decision });
    return { ok: true, message: `${run.featureId} 사용자 호출 (${kind}): ${summary}\n사용자가 돌아올 때까지 멈춘다. 답을 받으면 resume 한다.`, decision };
  });
}

// 사용자가 돌아와 답했을 때. 답을 기록하고 자율 진행을 이어간다.
export async function cmdResume(ctx, opts) {
  const text = requireApproval(opts, 'resume');
  return withLock(ctx, 'resume', async () => {
    const run = resolveRun(ctx, opts);
    if (!run.waiting) throw blocked('NOT_WAITING', `${run.featureId} 는 사용자를 기다리고 있지 않다.`);
    const waited = run.waiting;
    run.resumes ??= [];
    run.resumes.push({ ...waited, resumedAt: ctx.now(), answer: redact(text).slice(0, 2000) });
    run.waiting = null;
    saveRun(ctx, run);
    resetStopGuard(ctx);
    appendEvent(ctx, run, { type: 'RESUMED', status: run.phase, actor: 'master', summary: `사용자 답변으로 재개 (${waited.kind})`, reason: `사용자 답변: ${text.slice(0, 300)}` });
    return { ok: true, message: `${run.featureId} 재개 — 단계: ${PHASE_LABELS[run.phase]}` };
  });
}

// ---------- 세션 훅 판단 (PermissionRequest · Stop · Notification) ----------

function pendingPermissionFile(ctx) {
  return path.join(ctx.workflowRoot, 'state', 'pending-permission.json');
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// 반환: 'allow' 또는 null (권한 확인을 사용자에게 넘긴다).
// 파일 수정은 PreToolUse 범위 훅이 먼저 판단했으므로 자율 진행 중이면 허용한다.
export function decidePermission(ctx, input) {
  const run = activeAutonomousRun(ctx);
  if (!run) return null;
  const tool = input?.tool_name;
  const command = input?.tool_input?.command;
  if (EDIT_TOOLS.has(tool)) return 'allow';
  if (tool === 'Bash' && commandAllowed(ctx, command)) return 'allow';
  // 사용자에게 넘어가는 권한 요청. 이어지는 Notification 이 무엇을 기다리는지 알릴 수 있게 남긴다.
  writeJsonAtomic(pendingPermissionFile(ctx), { runId: run.runId, tool, command: typeof command === 'string' ? redact(command).slice(0, 300) : null, at: ctx.now() });
  return null;
}

function stopGuardFile(ctx) {
  return path.join(ctx.workflowRoot, 'state', 'stop-guard.json');
}

export function resetStopGuard(ctx) {
  fs.rmSync(stopGuardFile(ctx), { force: true });
}

function lastEvent(ctx, run) {
  return readEvents(ctx, run.runId).records.at(-1) ?? null;
}

// Stop 훅: 자율 진행 중인데 master 가 멈추려 하면 다음 할 일을 알려 이어가게 한다.
// 새 이벤트 없이 거듭 멈추면 상한(3번) 뒤 사용자를 부른다. 반환: { block, reason } 또는 { escalate: summary } 또는 null.
export function decideStop(ctx, input) {
  const run = activeAutonomousRun(ctx);
  if (!run) {
    resetStopGuard(ctx);
    return null;
  }
  const last = lastEvent(ctx, run);
  const seq = last?.sequence ?? 0;
  let guard = null;
  try { guard = readJson(stopGuardFile(ctx)); } catch { /* 처음 */ }
  const stuck = guard && guard.runId === run.runId && guard.seq === seq;
  const blocks = stuck ? guard.blocks + 1 : 1;
  if (blocks > MAX_STOP_BLOCKS) {
    resetStopGuard(ctx);
    return { escalate: `master 가 ${PHASE_LABELS[run.phase]} 단계에서 진행 없이 멈췄다 (마지막: ${last?.summary?.slice(0, 120) ?? '없음'}).`, run };
  }
  writeJsonAtomic(stopGuardFile(ctx), { runId: run.runId, seq, blocks, at: ctx.now() });
  const cli = `node "${path.join(ctx.engineDir, 'cli.mjs')}"`;
  return {
    block: true,
    reason: [
      `[ai-workflow 자율 진행] ${run.featureId} "${run.title}" — ${PHASE_LABELS[run.phase]}. 사용자는 자리에 없다. 멈추지 말고 이어서 진행한다.`,
      last?.nextAction ? `다음 할 일: ${last.nextAction}` : `현재 상태는 ${cli} status --feature ${run.featureId} 로 확인한다.`,
      `사용자 판단이 꼭 필요하면 질문하고 멈추지 말고 ${cli} escalate --feature ${run.featureId} --kind <plan|blocked|other> --summary "<이유>" 를 실행한 뒤 멈춘다.`,
      `(${blocks}/${MAX_STOP_BLOCKS} — 진행 없이 계속 멈추면 사용자를 부른다)`,
    ].join('\n'),
  };
}

// Notification 훅: 권한 확인·입력 대기로 세션이 멈추면 사용자를 부른다. 반환: { run, kind, summary } 또는 null.
export function decideNotification(ctx, input) {
  const type = input?.notification_type;
  if (type !== 'permission_prompt' && type !== 'idle_prompt') return null;
  if (type === 'idle_prompt') {
    // 이미 사용자를 부른 실행(확정 요청 등)은 다시 부르지 않는다.
    const run = activeAutonomousRun(ctx);
    if (!run) return null;
    return { run, kind: 'stalled', summary: 'master 가 입력을 기다리며 멈췄다. Claude Code 에서 확인해 주세요.' };
  }
  let pending = null;
  try { pending = readJson(pendingPermissionFile(ctx)); } catch { /* 기록 없음 */ }
  const runs = autonomousRuns(ctx);
  const run = runs.find((r) => r.runId === pending?.runId) ?? activeAutonomousRun(ctx);
  if (!run) return null;
  const what = pending?.command ? `\`${pending.command}\`` : pending?.tool ?? redact(String(input.message ?? '')).slice(0, 200);
  return { run, kind: 'permission', summary: `${what}` };
}

export function clearPendingPermission(ctx) {
  fs.rmSync(pendingPermissionFile(ctx), { force: true });
}

// 훅에서 사용자를 부를 때. 다른 명령이 잠금을 잡고 있으면 조금 뒤 다시 시도한다.
export async function escalateFromHook(ctx, runId, { kind, summary }) {
  for (let i = 0; i < 5; i++) {
    try {
      return await withLock(ctx, `hook-${kind}`, async () => {
        const run = listRuns(ctx).find((r) => r.runId === runId);
        if (!run || (run.waiting && run.waiting.kind === kind && run.waiting.summary === summary)) return null;
        return escalate(ctx, run, { kind, summary });
      });
    } catch (e) {
      if (!(e instanceof WorkflowError) || e.exitCode !== 4) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return null;
}

