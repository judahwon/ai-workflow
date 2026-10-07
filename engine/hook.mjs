#!/usr/bin/env node
// Claude Code PreToolUse 훅. 파일 수정 도구(Edit·Write·MultiEdit·NotebookEdit)의 대상 경로를
// 진행 중인 작업의 수정 허용 범위와 대조해, 범위 밖이면 거부 결정을 출력한다.
// 진행 중인 작업이 없으면 보호 경로(엔진·실행 상태·.env·.git)만 막는다.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createContext } from './context.mjs';
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
  let ctx;
  try {
    ctx = createContext(ctxOverrides);
    const decision = decideEdit(ctx, filePath);
    return decision.allow ? null : deny(decision.reason);
  } catch (e) {
    // 진행 중인 작업이 있을 때만 막는다. 훅 고장으로 작업이 없는 세션까지 막지 않는다.
    const focusExists = ctx ? fs.existsSync(focusFile(ctx)) : false;
    if (!focusExists) return null;
    return deny(`범위 판단 실패 (${e?.code ?? e?.name ?? 'Error'}). \`node .ai-workflow/engine/cli.mjs status\` 로 상태를 확인한다.`);
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
