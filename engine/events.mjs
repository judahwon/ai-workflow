// append-only 실행 이벤트. 이벤트를 먼저 저장하고, 알림이 켜져 있으면 전송 대기열에 넣는다.
import path from 'node:path';
import { appendJsonl, readJsonl, redact } from './util.mjs';

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
  };
  appendJsonl(file, event);
  if (notificationsEnabled(ctx)) {
    appendJsonl(notificationsFile(ctx, run.runId), { eventId: event.eventId, status: 'PENDING', at: ctx.now(), attempts: 0 });
  }
  return event;
}

export function readEvents(ctx, runId) {
  return readJsonl(eventsFile(ctx, runId));
}
