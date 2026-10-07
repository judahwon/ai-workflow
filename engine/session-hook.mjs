#!/usr/bin/env node
// 자율 진행용 Claude Code 훅. 사용: node session-hook.mjs <PermissionRequest|Stop|Notification>
// - PermissionRequest: 자율 진행 중이면 파일 수정과 허용 명령(autonomy.json·엔진 명령)을 권한 확인 없이 허용한다.
// - Stop: 자율 진행 중인데 master 가 멈추려 하면 다음 할 일을 알려 이어가게 한다. 진행 없이 거듭 멈추면 사용자를 부른다.
// - Notification: 권한 확인·입력 대기로 세션이 멈추면 Slack 으로 사용자를 부른다.
// ai-workflow 를 쓰지 않는 프로젝트, 엔진을 직접 설치한 프로젝트, 자율 진행이 아닌 기능에서는 아무것도 하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, isVendoredEngine, WORKFLOW_DIR_NAME } from './context.mjs';
import { decidePermission, decideStop, decideNotification, escalateFromHook, clearPendingPermission } from './autonomy.mjs';
import { flushNotifications } from './notify.mjs';
import { notificationsEnabled } from './events.mjs';

function contextFor(input, ctxOverrides) {
  if (ctxOverrides.workflowRoot) return createContext(ctxOverrides);
  const engineDir = ctxOverrides.engineDir ?? path.dirname(fileURLToPath(import.meta.url));
  if (isVendoredEngine(engineDir)) return createContext(ctxOverrides);
  const projectRoot = ctxOverrides.projectRoot ?? process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const workflowRoot = path.join(projectRoot, WORKFLOW_DIR_NAME);
  if (!fs.existsSync(workflowRoot) || fs.existsSync(path.join(workflowRoot, 'engine'))) return null;
  return createContext({ ...ctxOverrides, projectRoot, workflowRoot, mode: 'plugin' });
}

async function notifyNow(ctx) {
  if (!notificationsEnabled(ctx) || ctx.config.errors.length) return;
  try { await flushNotifications(ctx); } catch { /* 알림 실패가 세션을 막지 않는다. notify 로 다시 보낸다 */ }
}

// 반환: 출력할 JSON 객체 또는 null.
export async function runSessionHook(event, rawInput, ctxOverrides = {}) {
  let input;
  try {
    input = JSON.parse(String(rawInput).replace(/^﻿/, ''));
  } catch {
    return null;
  }
  let ctx;
  try {
    ctx = contextFor(input, ctxOverrides);
  } catch {
    return null; // 설정·버전 문제로 컨텍스트를 못 만들면 세션을 방해하지 않는다.
  }
  if (!ctx) return null;
  try {
    if (event === 'PermissionRequest') {
      if (decidePermission(ctx, input) !== 'allow') return null;
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    }
    if (event === 'Stop') {
      const d = decideStop(ctx, input);
      if (!d) return null;
      if (d.escalate) {
        await escalateFromHook(ctx, d.run.runId, { kind: 'stalled', summary: d.escalate });
        await notifyNow(ctx);
        return null;
      }
      return { decision: 'block', reason: d.reason };
    }
    if (event === 'Notification') {
      const d = decideNotification(ctx, input);
      if (!d) return null;
      await escalateFromHook(ctx, d.run.runId, { kind: d.kind, summary: d.summary });
      if (d.kind === 'permission') clearPendingPermission(ctx);
      await notifyNow(ctx);
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()) {
  readStdin().then(async (raw) => {
    const output = await runSessionHook(process.argv[2], raw);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  });
}
