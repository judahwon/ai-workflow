#!/usr/bin/env node
// Claude Code PreToolUse 훅. 파일 수정 도구(Edit·Write·MultiEdit·NotebookEdit)의 대상 경로를
// 진행 중인 작업의 수정 허용 범위와 대조해, 범위 밖이면 거부 결정을 출력한다.
// 진행 중인 작업이 없으면 보호 경로(엔진·실행 상태·.env·.git)만 막는다.
// 플러그인으로 쓰면 모든 프로젝트에서 불리므로, ai-workflow 를 쓰지 않는 프로젝트(.ai-workflow/ 없음)와
// 엔진을 직접 설치한 프로젝트(그 엔진의 훅이 판단한다)는 건너뛴다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, isVendoredEngine, WORKFLOW_DIR_NAME } from './context.mjs';
import { decideEdit, focusFile } from './develop.mjs';

export function targetPath(input) {
  const toolInput = input?.tool_input ?? {};
  const value = toolInput.file_path ?? toolInput.notebook_path;
  return typeof value === 'string' && value ? value : null;
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ai-workflow] ${reason}`,
    },
  };
}

// 반환: 출력할 JSON 객체 또는 null(허용).
export function runHook(rawInput, ctxOverrides = {}) {
  let input;
  try {
    // Windows PowerShell 파이프는 UTF-8 BOM 을 붙인다.
    input = JSON.parse(String(rawInput).replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const filePath = targetPath(input);
  if (!filePath) return null;
  const engineDir = ctxOverrides.engineDir ?? path.dirname(fileURLToPath(import.meta.url));
  if (!isVendoredEngine(engineDir) && !ctxOverrides.workflowRoot) {
    const projectRoot = ctxOverrides.projectRoot ?? process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
    const workflowRoot = path.join(projectRoot, WORKFLOW_DIR_NAME);
    if (!fs.existsSync(workflowRoot) || fs.existsSync(path.join(workflowRoot, 'engine'))) return null;
    ctxOverrides = { ...ctxOverrides, projectRoot, workflowRoot, mode: 'plugin' };
  }
  let ctx;
  try {
    ctx = createContext(ctxOverrides);
    const decision = decideEdit(ctx, filePath);
    return decision.allow ? null : deny(decision.reason);
  } catch (e) {
    // 진행 중인 작업이 있을 때만 막는다. 훅 고장으로 작업이 없는 세션까지 막지 않는다.
    // 엔진 버전이 프로젝트보다 낮아 컨텍스트를 못 만든 경우도 진행 중인 작업이 있으면 막는다.
    const workflowRoot = ctx?.workflowRoot ?? ctxOverrides.workflowRoot ?? (isVendoredEngine(engineDir) ? path.dirname(engineDir) : null);
    const focusExists = workflowRoot ? fs.existsSync(focusFile({ workflowRoot })) : false;
    if (!focusExists) return null;
    return deny(`범위 판단 실패 (${e?.code ?? e?.name ?? 'Error'}${e?.code === 'ENGINE_OUTDATED' ? ' — ai-workflow 플러그인을 업데이트한다' : ''}). ai-workflow 의 \`status\` 로 상태를 확인한다.`);
  }
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
  readStdin().then((raw) => {
    const output = runHook(raw);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  });
}
