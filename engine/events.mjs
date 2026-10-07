// append-only 실행 이벤트. 이벤트를 먼저 저장하고, 알림이 켜져 있으면 전송 대기열에 넣는다.
import path from 'node:path';
import { appendJsonl, readJsonl, redact } from './util.mjs';
import { describeAlert, isImportant } from './alerts.mjs';

export function runDir(ctx, runId) {
  return path.join(ctx.workflowRoot, 'runs', runId);
}

export function eventsFile(ctx, runId) {
  return path.join(runDir(ctx, runId), 'events.jsonl');
}

export function notificationsFile(ctx, runId) {
  return path.join(runDir(ctx, runId), 'notifications.jsonl');
}

export function notificationsEnabled(ctx) {
  return ctx.config?.values?.AIWF_SLACK_ENABLED === 'true';
}

// Slack 으로 보내는 이벤트 (단계 전환·사용자 확인이 필요한 것). 나머지는 기록만 한다.
export const NOTIFY_TYPES = new Set([
  'RUN_CREATED', 'REQUIREMENTS_CONFIRMED', 'DESIGN_CONFIRMED', 'REQUIREMENTS_UPDATED', 'DESIGN_UPDATED',
  'TASK_DONE', 'TASK_REOPENED', 'REVIEW_DONE', 'REVIEW_FAILED', 'REVIEW_ACCEPTED', 'VERIFY_DONE', 'CONFIRMED', 'RUN_DONE',
  'ESCALATED', 'RESUMED',
]);

export function appendEvent(ctx, run, fields) {
  const file = eventsFile(ctx, run.runId);
  const { records } = readJsonl(file);
  const sequence = records.reduce((max, r) => Math.max(max, Number(r.sequence) || 0), 0) + 1;
  const event = {
    eventId: `${run.runId}-E${String(sequence).padStart(5, '0')}`,
    sequence,
    timestamp: ctx.now(),
    type: fields.type,
    runId: run.runId,
    featureId: run.featureId,
    title: run.title ?? null,
    phase: run.phase ?? null,
    requirementVersion: run.approvals?.plan?.version ?? null,
    designVersion: run.approvals?.design?.version ?? null,
    taskId: fields.taskId ?? null,
    testId: fields.testId ?? null,
    attempt: fields.attempt ?? null,
    actor: fields.actor ?? 'controller',
    status: fields.status ?? null,
    summary: redact(fields.summary ?? '').slice(0, 2000),
    reason: fields.reason ? redact(fields.reason).slice(0, 1000) : null,
    evidencePaths: fields.evidencePaths ?? [],
    nextAction: fields.nextAction ? redact(fields.nextAction).slice(0, 500) : null,
    // 알림 문구용 숫자·이름 (작업 n/m, 지적 건수 등)과 사용자가 고를 선택지.
    data: fields.data ?? null,
    decision: fields.decision ?? null,
    // 자율 진행 중인 실행이면 멘션은 사용자를 부를 때(escalation)만 한다.
    autonomous: run.autonomy?.enabled === true,
    escalation: fields.escalation ?? null,
  };
  appendJsonl(file, event);
  if (notificationsEnabled(ctx) && NOTIFY_TYPES.has(event.type) && wanted(ctx, event)) {
    appendJsonl(notificationsFile(ctx, run.runId), { eventId: event.eventId, status: 'PENDING', at: ctx.now(), attempts: 0 });
  }
  return event;
}

// 알림 수준 important 면 기능 시작·완료와 사람이 반응할 것(확인 필요·오류)만 보낸다.
function wanted(ctx, event) {
  if (ctx.config.values.AIWF_SLACK_LEVEL !== 'important') return true;
  const alert = describeAlert(event);
  return !alert || isImportant(event, alert);
}

export function readEvents(ctx, runId) {
  return readJsonl(eventsFile(ctx, runId));
}
