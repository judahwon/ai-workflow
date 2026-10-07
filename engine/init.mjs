// init: .ai-workflow/.env 를 질의로 채우고 git 제외를 보장한다.
// 대화형(TTY)이면 readline 으로 묻고, 아니면 --set KEY=VALUE 로 받는다 (Claude Code 는 사용자에게 물은 뒤 --set 으로 넘긴다).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { WorkflowError, atomicWriteFile, usageError } from './util.mjs';
import { serializeEnv, writeEnvFile } from './envfile.mjs';
import {
  CONFIG_SECTIONS, CONFIG_KEYS, ENV_EXAMPLE_FILE, configKey, validateConfig, looksLikeSecret,
  envPath, checkEnvIgnored,
} from './config.mjs';
import { withLock } from './lock.mjs';

export const GITIGNORE_LINES = ['.env', '.env.*', '!.env.example', 'runs/', 'state/'];

const ENV_HEADER = [
  'ai-workflow 설정. 프로젝트 정보·개인 정보·이 PC 경로를 모두 여기에 둔다.',
  '이 파일은 git 에서 제외된다(.ai-workflow/.gitignore). 토큰·비밀번호 값은 넣지 않는다.',
  '`node .ai-workflow/engine/cli.mjs init` 으로 다시 질의하거나 직접 고친다.',
];

const EXAMPLE_HEADER = [
  'ai-workflow 설정 예시 (키 이름과 설명만). 실제 값은 같은 폴더의 .env 에 둔다.',
  '`node .ai-workflow/engine/cli.mjs init` 이 질의로 .env 를 만든다.',
];

// .gitignore 에 필요한 줄이 없으면 덧붙인다. 기존 줄은 지우지 않는다.
export function ensureGitignore(workflowRoot) {
  const file = path.join(workflowRoot, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return [];
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const block = `${existing ? '\n' : ''}# ai-workflow: 설정(.env)과 실행 기록은 커밋하지 않는다\n${missing.join('\n')}\n`;
  atomicWriteFile(file, `${existing}${prefix}${block}`);
  return missing;
}

export function writeEnvExample(workflowRoot) {
  atomicWriteFile(path.join(workflowRoot, ENV_EXAMPLE_FILE), serializeEnv(CONFIG_SECTIONS, {}, { header: EXAMPLE_HEADER }));
}

// "KEY=VALUE" 목록을 객체로. 알 수 없는 키·비밀값은 디스크에 쓰기 전에 거부한다.
export function parseSetOptions(list) {
  const result = {};
  for (const item of list ?? []) {
    const at = item.indexOf('=');
    if (at <= 0) throw usageError(`--set 은 KEY=VALUE 형식이다: ${JSON.stringify(item.slice(0, 40))}`);
    const name = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (!configKey(name)) throw usageError(`알 수 없는 설정 키: ${name}`);
    if (looksLikeSecret(value)) {
      throw new WorkflowError('SECRET_VALUE', `${name}: 토큰·비밀값으로 보여 저장하지 않는다. 암호화된 파일 경로만 넣는다.`, { exitCode: 3 });
    }
    result[name] = value;
  }
  return result;
}

async function defaultPrompt(questions) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await questions(async (text) => rl.question(text));
  } finally {
    rl.close();
  }
}

// 대화형 질의. 빈 입력은 현재 값(없으면 기본값)을 유지한다. "-" 는 값을 비운다.
async function askInteractively(ctx, values, keys) {
  const ask = ctx.prompt ?? defaultPrompt;
  return ask(async (question) => {
    for (const key of keys) {
      for (;;) {
        const current = values[key.name] ?? '';
        const shown = current || key.default || '';
        const answer = (await question(`${key.question}${shown ? ` [${shown}]` : ''}: `)).trim();
        const next = answer === '' ? current || key.default || '' : answer === '-' ? '' : answer;
        if (next && looksLikeSecret(next)) {
          ctx.out('  토큰·비밀값으로 보여 받지 않습니다. 암호화된 파일의 경로만 넣어 주세요.');
          continue;
        }
        const problem = next ? key.validate?.(next) : null;
        if (problem) {
          ctx.out(`  형식 오류: ${problem}`);
          continue;
        }
        values[key.name] = next;
        break;
      }
    }
    return values;
  });
}

export async function cmdInit(ctx, opts) {
  return withLock(ctx, 'init', async () => {
    fs.mkdirSync(path.join(ctx.workflowRoot, 'features'), { recursive: true });
    const addedIgnore = ensureGitignore(ctx.workflowRoot);
    writeEnvExample(ctx.workflowRoot);

    const before = ctx.reloadConfig();
    const values = { ...before.raw };
    Object.assign(values, parseSetOptions(opts.set));

    const interactive = ctx.stdinIsTTY && !opts['non-interactive'];
    if (interactive) {
      const pending = opts.all || !before.exists
        ? CONFIG_KEYS
        : CONFIG_KEYS.filter((k) => validateConfig(values).errors.some((e) => e.key === k.name));
      // 처음 실행이면 모든 항목을 순서대로 묻고, 이후에는 빠지거나 잘못된 항목만 묻는다.
      await askInteractively(ctx, values, pending);
      // Slack 을 켰으면 그 뒤에 필요해진 항목을 다시 확인한다.
      const stillMissing = CONFIG_KEYS.filter((k) => validateConfig(values).errors.some((e) => e.key === k.name));
      if (stillMissing.length) await askInteractively(ctx, values, stillMissing);
    }

    // 기본값도 파일에 적어 무엇이 쓰이는지 보이게 한다. 알 수 없는 키는 버리지 않고 오류로 남겨 사용자가 확인하게 한다.
    const known = Object.fromEntries(CONFIG_KEYS.map((k) => [k.name, values[k.name] || k.default || '']));
    const unknownKeys = Object.keys(values).filter((name) => !configKey(name));
    let content = serializeEnv(CONFIG_SECTIONS, known, { header: ENV_HEADER });
    if (unknownKeys.length) {
      content += `\n# ===== 알 수 없는 키 (확인 후 지운다) =====\n${unknownKeys.map((k) => `${k}=${values[k]}`).join('\n')}\n`;
    }
    writeEnvFile(envPath(ctx.workflowRoot), content);
    const after = ctx.reloadConfig();

    const ignore = checkEnvIgnored(ctx);
    const lines = [];
    if (addedIgnore.length) lines.push(`.ai-workflow/.gitignore 에 추가: ${addedIgnore.join(', ')}`);
    lines.push(`설정 파일: ${path.relative(ctx.projectRoot, after.file).split(path.sep).join('/')}`);
    lines.push(`git 제외 상태: ${describeIgnore(ignore.state)}`);
    if (after.errors.length) {
      lines.push('아직 채워야 하는 항목:');
      for (const e of after.errors) lines.push(`  - ${e.key}: ${e.message}`);
    } else {
      lines.push('설정 완료.');
    }
    const ok = after.errors.length === 0 && !['TRACKED', 'NOT_IGNORED'].includes(ignore.state);
    return { ok, message: lines.join('\n'), missing: after.errors.map((e) => e.key) };
  });
}

export function describeIgnore(state) {
  return {
    IGNORED: '제외됨',
    NOT_IGNORED: '제외되지 않음 — .ai-workflow/.gitignore 확인 필요',
    TRACKED: '이미 git 에 추적됨 — git rm --cached .ai-workflow/.env 필요',
    NO_GIT: 'git 저장소가 아님 (커밋 위험 없음, 단 코드 버전 확인 불가)',
    GIT_UNAVAILABLE: 'git 을 실행할 수 없음',
  }[state] ?? state;
}

// Claude Code 가 사용자에게 물을 질문 목록 (JSON). 값은 출력하지 않고 채워졌는지만 알린다.
export async function cmdQuestions(ctx) {
  const config = ctx.reloadConfig();
  const items = CONFIG_SECTIONS.map((section) => ({
    section: section.title,
    keys: section.keys.map((k) => ({
      key: k.name,
      question: k.question,
      default: k.default ?? null,
      filled: Boolean(config.raw[k.name]),
      error: config.errors.find((e) => e.key === k.name)?.message ?? null,
    })),
  }));
  return { ok: true, message: JSON.stringify(items, null, 2) };
}
