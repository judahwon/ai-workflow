// Slack 알림: 단계 전환 이벤트를 실행별 스레드로 보낸다 (AIWF_SLACK_ENABLED=true 일 때).
// 토큰은 Node 에서 읽지 않는다. Windows 에서 PowerShell 전송 스크립트가 현재 사용자로 암호화된 토큰 파일을 복호화한다.
// 알림 실패는 작업 상태를 바꾸지 않는다. 수신 여부 불명(DELIVERY_UNCERTAIN)은 자동으로 다시 보내지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, readJsonl, writeJsonAtomic, readJson, redact } from './util.mjs';
import { eventsFile, notificationsFile, notificationsEnabled, runDir } from './events.mjs';
import { formatAlert } from './alerts.mjs';

export const MAX_ATTEMPTS = 3;
const MAX_PER_FLUSH = 30;
const TRANSPORT_TIMEOUT_MS = 60 * 1000;
// 사용자가 반응해야 하는 이벤트는 사용자를 멘션한다.
const ATTENTION = new Set(['REQUIREMENTS_UPDATED', 'DESIGN_UPDATED', 'REVIEW_FAILED', 'RUN_DONE']);

export function latestNotificationStates(ctx, runId) {
  const states = new Map();
  for (const record of readJsonl(notificationsFile(ctx, runId)).records) {
    if (record?.eventId) states.set(record.eventId, { ...(states.get(record.eventId) ?? {}), ...record });
  }
  return states;
}

export function formatMessage(ctx, event) {
  const values = ctx.config.values;
  const alert = formatAlert(event, values);
  if (alert) return redact(alert).slice(0, 3000);
  // 알림 문구가 정해지지 않은 이벤트는 원래 형식으로 보낸다.
  const attention = ATTENTION.has(event.type)
    || (event.type === 'REVIEW_DONE' && event.status !== 'APPROVED')
    || (event.type === 'VERIFY_DONE' && event.status !== 'PASS');
  const scope = [event.featureId, event.runId, event.taskId, event.testId].filter(Boolean).join(' / ');
  const lines = [
    `${attention && values.AIWF_SLACK_USER_ID ? `<@${values.AIWF_SLACK_USER_ID}> ` : ''}[${values.AIWF_PROJECT_NAME}] ${event.type} — ${scope}`,
    `상태: ${event.status ?? '-'}`,
  ];
  if (event.summary) lines.push(event.summary);
  if (event.reason) lines.push(`사유: ${event.reason}`);
  if (event.nextAction) lines.push(`다음: ${event.nextAction}`);
  return redact(lines.join('\n')).slice(0, 3000);
}

function eligible(state, opts, nowMs) {
  switch (state.status) {
    case 'PENDING': return true;
    case 'RETRY_PENDING': return !state.nextAttemptAt || Date.parse(state.nextAttemptAt) <= nowMs;
    case 'SENDING':
    case 'DELIVERY_UNCERTAIN': return opts.retryUncertain === true;
    case 'DELIVERY_FAILED': return opts.retryFailed === true;
    default: return false;
  }
}

function parseTransportOutput(stdout) {
  const last = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  try {
    const data = JSON.parse(last);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function classify(ctx, proc, out, attempts) {
  const base = { attempts };
  const failOrRetry = (extra) => ({ ...base, status: attempts >= MAX_ATTEMPTS ? 'DELIVERY_FAILED' : 'RETRY_PENDING', ...extra });
  if (proc.spawnError) return failOrRetry({ errorType: `SPAWN_${proc.spawnError.code}` });
  if (proc.timedOut || !out) return { ...base, status: 'DELIVERY_UNCERTAIN', errorType: proc.timedOut ? 'TRANSPORT_TIMEOUT' : 'TRANSPORT_OUTPUT_UNREADABLE' };
  if (out.ok === true && typeof out.ts === 'string') return { ...base, status: 'SENT', ts: out.ts };
  if (out.uncertain === true) return { ...base, status: 'DELIVERY_UNCERTAIN', errorType: String(out.errorType ?? 'UNKNOWN').slice(0, 80) };
  if (out.configError) return { ...base, status: 'DELIVERY_FAILED', errorType: `CONFIG_${String(out.configError).slice(0, 60)}` };
  if (out.httpStatus === 429) {
    const wait = Math.min(Math.max(Number(out.retryAfter) || 30, 1), 3600);
    return failOrRetry({ httpStatus: 429, nextAttemptAt: new Date(Date.parse(ctx.now()) + wait * 1000).toISOString() });
  }
  return failOrRetry({ httpStatus: out.httpStatus ?? null, slackError: typeof out.slackError === 'string' ? out.slackError.slice(0, 80) : null, errorType: out.errorType ? String(out.errorType).slice(0, 80) : null });
}

// 페이로드 파일 하나를 보낸다. 반환: 전송 스크립트의 결과 객체 + proc
export async function sendPayload(ctx, payloadPath) {
  const values = ctx.config.values;
  if (ctx.platform !== 'win32') {
    return { proc: { exitCode: 2, stdout: '' }, out: { ok: false, configError: 'UNSUPPORTED_PLATFORM' } };
  }
  const proc = await ctx.runProcess({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.engineDir, 'slack-send.ps1'),
      '-PayloadFile', payloadPath, '-TokenFile', values.AIWF_SLACK_TOKEN_FILE, '-Channel', values.AIWF_SLACK_CHANNEL_ID],
    cwd: ctx.workflowRoot,
    env: ctx.env,
    input: '',
    timeoutMs: TRANSPORT_TIMEOUT_MS,
  });
  return { proc, out: parseTransportOutput(proc.stdout) };
}

async function flushRun(ctx, runId, opts, budget) {
  const summary = { runId, sent: 0, retryPending: 0, uncertain: 0, failed: 0, skipped: 0 };
  const states = latestNotificationStates(ctx, runId);
  const events = new Map(readJsonl(eventsFile(ctx, runId)).records.map((e) => [e.eventId, e]));
  const nowMs = Date.parse(ctx.now());
  const queue = [...states.values()]
    .filter((s) => eligible(s, opts, nowMs))
    .sort((a, b) => (events.get(a.eventId)?.sequence ?? 0) - (events.get(b.eventId)?.sequence ?? 0));
  const threadFile = path.join(runDir(ctx, runId), 'slack-thread.json');
  let threadTs = fs.existsSync(threadFile) ? readJson(threadFile).threadTs ?? null : null;
  const record = (r) => appendJsonl(notificationsFile(ctx, runId), { at: ctx.now(), ...r });
  for (const state of queue) {
    if (budget.remaining <= 0) {
      summary.skipped++;
      continue;
    }
    budget.remaining--;
    const event = events.get(state.eventId);
    const attempts = (Number(state.attempts) || 0) + 1;
    if (!event) {
      record({ eventId: state.eventId, status: 'DELIVERY_FAILED', attempts, errorType: 'EVENT_MISSING' });
      summary.failed++;
      continue;
    }
    const payloadPath = path.join(runDir(ctx, runId), 'outbox', `${event.eventId}.json`);
    writeJsonAtomic(payloadPath, { channel: ctx.config.values.AIWF_SLACK_CHANNEL_ID, text: formatMessage(ctx, event), threadTs });
    record({ eventId: event.eventId, status: 'SENDING', attempts });
    let outcome;
    try {
      const { proc, out } = await sendPayload(ctx, payloadPath);
      outcome = classify(ctx, proc, out, attempts);
    } catch {
      outcome = { attempts, status: 'DELIVERY_UNCERTAIN', errorType: 'TRANSPORT_EXCEPTION' };
    }
    record({ eventId: event.eventId, ...outcome });
    if (outcome.status === 'SENT') {
      summary.sent++;
      if (!threadTs) {
        threadTs = outcome.ts;
        writeJsonAtomic(threadFile, { threadTs, rootEventId: event.eventId });
      }
    } else if (outcome.status === 'RETRY_PENDING') {
      summary.retryPending++;
      if (outcome.httpStatus === 429) break;
    } else if (outcome.status === 'DELIVERY_UNCERTAIN') {
      summary.uncertain++;
    } else {
      summary.failed++;
      if (String(outcome.errorType).startsWith('CONFIG_')) break; // 설정 문제는 나머지도 같은 이유로 실패한다.
    }
  }
  return summary;
}

export async function flushNotifications(ctx, opts = {}) {
  if (!notificationsEnabled(ctx)) return { enabled: false, runs: [] };
  const runsRoot = path.join(ctx.workflowRoot, 'runs');
  const runIds = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot).filter((d) => fs.existsSync(notificationsFile(ctx, d))).sort() : [];
  const budget = { remaining: MAX_PER_FLUSH };
  const runs = [];
  for (const id of runIds) runs.push(await flushRun(ctx, id, opts, budget));
  return { enabled: true, runs };
}

export function describeFlush(result) {
  const total = (key) => result.runs.reduce((n, r) => n + r[key], 0);
  return `Slack 알림: 보냄 ${total('sent')}, 재시도 대기 ${total('retryPending')}, 수신 불명 ${total('uncertain')}, 실패 ${total('failed')}${total('skipped') ? `, 다음으로 미룸 ${total('skipped')}` : ''}`;
}

export async function cmdNotify(ctx, opts) {
  if (!notificationsEnabled(ctx)) return { ok: true, message: 'Slack 알림이 꺼져 있다 (AIWF_SLACK_ENABLED=false).' };
  if (ctx.config.errors.length) return { ok: false, message: '설정 오류가 있다. init 으로 고친다.' };
  if (opts.test) {
    const payloadPath = path.join(ctx.workflowRoot, 'state', 'slack-test.json');
    writeJsonAtomic(payloadPath, { channel: ctx.config.values.AIWF_SLACK_CHANNEL_ID, text: `[${ctx.config.values.AIWF_PROJECT_NAME}] ai-workflow 알림 연결 확인 (${ctx.now()})`, threadTs: null });
    const { proc, out } = await sendPayload(ctx, payloadPath);
    fs.rmSync(payloadPath, { force: true });
    if (out?.ok) return { ok: true, message: 'Slack 시험 메시지를 보냈다.' };
    return { ok: false, message: `Slack 시험 전송 실패: ${out?.configError ?? out?.slackError ?? out?.errorType ?? `exit ${proc.exitCode}`}` };
  }
  const result = await flushNotifications(ctx, { retryUncertain: opts['retry-uncertain'] === true, retryFailed: opts['retry-failed'] === true });
  const failed = result.runs.some((r) => r.failed > 0);
  return { ok: !failed, message: describeFlush(result) };
}
