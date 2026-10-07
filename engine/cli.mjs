#!/usr/bin/env node
// ai-workflow CLI. 사용: node .ai-workflow/engine/cli.mjs <command> [options]  (프로젝트 루트에서)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WorkflowError, usageError } from './util.mjs';
import { createContext } from './context.mjs';
import { cmdInit, cmdQuestions } from './init.mjs';
import { cmdNew, cmdApprove, cmdStatus, cmdUnlock } from './runs.mjs';

const S = 'string';
const B = 'boolean';
const LIST = 'list';

export const COMMANDS = {
  help: { options: {}, run: async () => ({ ok: true, message: HELP }) },
  init: { options: { set: LIST, 'non-interactive': B, all: B }, run: cmdInit },
  questions: { options: {}, run: cmdQuestions },
  status: { options: { run: S, feature: S, all: B, json: B }, run: cmdStatus },
  new: { options: { title: S, feature: S }, run: cmdNew },
  approve: { options: { run: S, feature: S, phase: S, 'approval-text': S, 'user-confirmed': B }, run: cmdApprove },
  unlock: { options: { stale: B, reason: S, 'force-unverified': B }, run: cmdUnlock },
};

export const HELP = `사용: node .ai-workflow/engine/cli.mjs <command> [options]   (프로젝트 루트에서 실행)

설정
  init [--set KEY=VALUE ...] [--non-interactive] [--all]
      .ai-workflow/.env 를 질의로 채운다. 터미널이면 직접 묻고, 아니면 --set 으로 받는다.
      처음에는 모든 항목을, 이후에는 빠지거나 잘못된 항목만 묻는다 (--all 이면 전부).
  questions                 채울 항목과 질문 목록 (JSON, 값은 출력하지 않음)

기능 진행
  new --title "<기능 이름>" [--feature FEAT-###]
      기능 문서(decisions·requirements·design·tasks)를 만들고 논의 단계로 시작한다.
  approve (--run RUN | --feature FEAT) --phase plan|design --approval-text "<사용자 답변 원문>" --user-confirmed
      plan  : requirements.md 승인 (명세 버전·REQ 필요, 미결 질문 없어야 함) → 설계 단계
      design: design.md + tasks.json 승인 (모든 REQ 가 작업에 연결돼야 함) → 개발 단계
      사용자가 대화에서 실제로 진행을 확인한 뒤에만 실행한다.
  status [--run RUN | --feature FEAT] [--all] [--json]

관리
  unlock --stale --reason "<확인 내용>" [--force-unverified]

종료 코드: 0 성공, 1 오류, 2 사용법, 3 차단, 4 잠금`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help', opts: {} };
  const spec = COMMANDS[command];
  if (!spec) throw usageError(`알 수 없는 명령: ${JSON.stringify(command.slice(0, 40))}`);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(token);
    if (!match) throw usageError(`알 수 없는 인자: ${JSON.stringify(token.slice(0, 40))}`);
    const [, name, inline] = match;
    const type = spec.options[name];
    if (!type) throw usageError(`${command} 에 없는 옵션: --${name}`);
    if (type === B) {
      if (inline !== undefined) throw usageError(`--${name} 는 값을 받지 않는다.`);
      if (name in opts) throw usageError(`중복 옵션: --${name}`);
      opts[name] = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw usageError(`--${name} 값이 필요하다.`);
      i++;
    }
    if (type === LIST) {
      (opts[name] ??= []).push(value);
    } else {
      if (name in opts) throw usageError(`중복 옵션: --${name}`);
      opts[name] = value;
    }
  }
  return { command, opts };
}

export async function main(argv, ctxOverrides = {}) {
  let ctx;
  try {
    const { command, opts } = parseArgs(argv);
    if (command === 'help') {
      (ctxOverrides.out ?? ((l) => process.stdout.write(`${l}\n`)))(HELP);
      return 0;
    }
    ctx = createContext(ctxOverrides);
    const result = await COMMANDS[command].run(ctx, opts);
    if (result?.message) ctx.out(result.message);
    return result?.ok === false ? 3 : 0;
  } catch (e) {
    const out = ctx?.out ?? ctxOverrides.out ?? ((l) => process.stderr.write(`${l}\n`));
    if (e instanceof WorkflowError) {
      out(`[${e.code}] ${e.message}`);
      return e.exitCode;
    }
    // 원문 스택에 경로·환경 정보가 섞일 수 있어 형식과 코드만 출력한다.
    out(`[INTERNAL_ERROR] ${e?.name ?? 'Error'}${e?.code ? ` (${e.code})` : ''}${ctxOverrides.debug ? `: ${e?.stack}` : ''}`);
    return 1;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), { debug: process.env.AIWF_DEBUG === '1' }).then((code) => { process.exitCode = code; });
}
