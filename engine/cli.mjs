#!/usr/bin/env node
// ai-workflow CLI. 사용: node .ai-workflow/engine/cli.mjs <command> [options]  (프로젝트 루트에서)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WorkflowError, usageError } from './util.mjs';
import { createContext } from './context.mjs';
import { cmdInit, cmdQuestions } from './init.mjs';
import { cmdNew, cmdApprove, cmdStatus, cmdUnlock } from './runs.mjs';
import { cmdTaskStart, cmdTaskDone, cmdTaskPause, cmdTaskReopen, cmdCheckScope } from './develop.mjs';
import { cmdChecksSet, cmdVerify, cmdTestConfirm, cmdConfirm } from './verify.mjs';
import { cmdReview, cmdReviewAccept } from './review.mjs';
import { cmdDocsDone } from './docs.mjs';
import { cmdNotify, flushNotifications, describeFlush } from './notify.mjs';
import { notificationsEnabled } from './events.mjs';

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
  'task-start': { options: { run: S, feature: S, task: S }, run: cmdTaskStart },
  'task-done': { options: { run: S, feature: S, task: S, summary: S, 'extra-approved': S, 'user-confirmed': B }, run: cmdTaskDone },
  'task-pause': { options: {}, run: cmdTaskPause },
  'task-reopen': { options: { run: S, feature: S, task: S, reason: S }, run: cmdTaskReopen },
  'check-scope': { options: { path: S }, run: cmdCheckScope },
  'checks-set': { options: { from: S, 'approval-text': S, 'user-confirmed': B }, run: cmdChecksSet },
  review: { options: { run: S, feature: S }, run: cmdReview },
  'review-accept': { options: { run: S, feature: S, 'approval-text': S, 'user-confirmed': B }, run: cmdReviewAccept },
  verify: { options: { run: S, feature: S, only: LIST }, run: cmdVerify },
  'test-confirm': { options: { run: S, feature: S, test: S, 'approval-text': S, 'user-confirmed': B }, run: cmdTestConfirm },
  confirm: { options: { run: S, feature: S, 'approval-text': S, 'user-confirmed': B }, run: cmdConfirm },
  'docs-done': { options: { run: S, feature: S, summary: S, 'extra-approved': S, 'no-docs-approved': S, 'user-confirmed': B }, run: cmdDocsDone },
  notify: { options: { test: B, 'retry-uncertain': B, 'retry-failed': B }, run: cmdNotify },
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

개발
  task-start (--run RUN | --feature FEAT) --task TASK-###
      작업을 시작(또는 재개)한다. 의존 작업이 끝나야 하고, 진행 중인 작업은 하나뿐이다.
      이후 파일 수정 훅이 이 작업의 allowedFiles 밖 수정을 막는다.
  task-done (--run RUN | --feature FEAT) --task TASK-### --summary "<변경·확인 내용>"
            [--extra-approved "<사용자 답변 원문>" --user-confirmed]
      git 기준으로 작업 중 바뀐 파일을 확인한다. 범위 밖 파일이 있으면 막는다.
      모든 작업이 끝나면 검수 단계로 간다.
  task-pause                진행 중인 작업을 일시 중지하고 수정 범위 제한을 푼다.
  check-scope --path <파일>  지금 이 파일을 고칠 수 있는지 (훅과 같은 판단)

검수·검증·확정 (모든 작업이 끝나면 검수 단계)
  review (--run RUN | --feature FEAT)
      Codex(읽기 전용)가 요구사항·설계 대비 변경을 검토한다. 승인이면 검증 단계로 간다.
  review-accept (--run|--feature) --approval-text "<사용자 답변 원문>" --user-confirmed
      남은 지적이나 Codex 없이 사용자 허락으로 검수를 넘긴다.
  task-reopen (--run|--feature) --task TASK-### --reason "<이유>"
      검수·검증에서 고칠 것이 나오면 작업을 다시 열고 개발 단계로 돌아간다.
  checks-set [--from <JSON 파일>] --approval-text "<사용자 답변 원문>" --user-confirmed
      프로젝트 검사(.ai-workflow/checks.json: 린트·빌드·테스트 명령, 서버 주소)를 승인과 함께 저장한다.
  verify (--run|--feature) [--only ID ...]
      프로젝트 검사와 설계 승인된 기능 테스트(tests.json)를 실행한다. --only 는 일부만 (확정에는 전체 필요).
  test-confirm (--run|--feature) --test TEST-### --approval-text "<사용자 답변 원문>" --user-confirmed
      사람이 확인하는 manual 테스트의 통과를 기록한다.
  confirm (--run|--feature) --approval-text "<사용자 답변 원문>" --user-confirmed
      검수·전체 검증이 지금 코드 기준으로 통과했을 때 확정한다 → 문서 단계.

문서
  docs-done (--run|--feature) --summary "<쓴 문서>" [--extra-approved "..." | --no-docs-approved "..."] [--user-confirmed]
      확정 이후 문서 폴더(AIWF_DOCS_DIR)만 바뀌었는지 확인하고 report.md 를 남긴 뒤 완료한다.

알림
  notify [--test] [--retry-uncertain] [--retry-failed]
      Slack 알림 대기열을 보낸다 (다른 명령 뒤에도 자동으로 보낸다). --test 는 연결 확인 메시지.

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

// 실행 뒤 Slack 대기열을 자동으로 보내지 않는 명령.
const QUIET_COMMANDS = new Set(['help', 'init', 'questions', 'status', 'check-scope', 'notify', 'unlock']);

async function autoNotify(ctx, command) {
  if (!ctx || QUIET_COMMANDS.has(command) || !notificationsEnabled(ctx) || ctx.config.errors.length) return;
  try {
    const result = await flushNotifications(ctx);
    if (result.runs.some((r) => r.sent || r.failed || r.uncertain || r.retryPending)) ctx.out(describeFlush(result));
  } catch (e) {
    ctx.out(`[알림] Slack 전송 중 오류 (${e?.code ?? e?.name ?? 'Error'}). notify 로 다시 보낸다.`);
  }
}

export async function main(argv, ctxOverrides = {}) {
  let ctx;
  let command;
  try {
    const parsed = parseArgs(argv);
    command = parsed.command;
    const { opts } = parsed;
    if (command === 'help') {
      (ctxOverrides.out ?? ((l) => process.stdout.write(`${l}\n`)))(HELP);
      return 0;
    }
    ctx = createContext(ctxOverrides);
    const result = await COMMANDS[command].run(ctx, opts);
    if (result?.message) ctx.out(result.message);
    await autoNotify(ctx, command);
    return result?.ok === false ? 3 : 0;
  } catch (e) {
    const out = ctx?.out ?? ctxOverrides.out ?? ((l) => process.stderr.write(`${l}\n`));
    if (e instanceof WorkflowError) {
      out(`[${e.code}] ${e.message}`);
      await autoNotify(ctx, command);
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
