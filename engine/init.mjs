// init: .ai-workflow/.env 를 질의로 채우고 git 제외를 보장한다.
// 대화형(TTY)이면 readline 으로 묻고, 아니면 --set KEY=VALUE 로 받는다 (Claude Code 는 사용자에게 물은 뒤 --set 으로 넘긴다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { WorkflowError, atomicWriteFile, usageError } from './util.mjs';
import { serializeEnv, writeEnvFile, readEnvFile, quoteValue } from './envfile.mjs';
import {
  CONFIG_SECTIONS, CONFIG_KEYS, ENV_EXAMPLE_FILE, configKey, validateConfig, looksLikeSecret,
  checkEnvIgnored, isRequired,
} from './config.mjs';
import { withLock } from './lock.mjs';
import { stampProjectVersion } from './version.mjs';

export const GITIGNORE_LINES = ['.env', '.env.*', '!.env.example', 'runs/', 'state/'];

const PROJECT_HEADER = [
  'ai-workflow 프로젝트 설정. 팀이 같은 값을 쓰도록 커밋한다. 개인 경로·Slack ID·토큰은 넣지 않는다.',
  'ai-workflow 의 init 명령(Claude Code 에서는 aiwf-setup 스킬)으로 바꾼다.',
];

const USER_HEADER = [
  'ai-workflow 개인 설정. 이 PC 의 모든 프로젝트에 쓴다. 토큰·비밀번호 값은 넣지 않는다.',
  'ai-workflow 의 init 명령(Claude Code 에서는 aiwf-setup 스킬)으로 다시 질의하거나 직접 고친다.',
];

const LOCAL_HEADER = [
  'ai-workflow 개인 설정 중 이 프로젝트에서만 다르게 쓸 값. git 에서 제외된다(.ai-workflow/.gitignore).',
  'init --override --set KEY=VALUE 로 넣는다. 나머지 개인 값은 개인 설정 파일(~/.ai-workflow/user.env)에 있다.',
];

const EXAMPLE_HEADER = [
  'ai-workflow 설정 키 목록 (이름과 설명만).',
  '프로젝트·검수 항목은 project.env(커밋), 이 PC·알림 항목은 ~/.ai-workflow/user.env, 이 프로젝트에서만 다른 개인 값은 .env 에 둔다.',
  'ai-workflow 의 init 명령(Claude Code 에서는 aiwf-setup 스킬)이 질의로 채운다.',
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

// 로컬 전용: 프로젝트 .gitignore 는 건드리지 않고 이 PC 의 .git/info/exclude 에만 넣어 저장소에 흔적을 남기지 않는다.
// 프로젝트가 저장소의 하위 폴더여도 저장소의 exclude 에 그 폴더 기준 경로로 넣는다.
// 반환: 새로 넣은 줄 목록, git 저장소가 아니면 null.
export function addLocalExcludes(root, patterns) {
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const excludePath = git(['rev-parse', '--git-path', 'info/exclude']);
  const prefix = git(['rev-parse', '--show-prefix']);
  if (excludePath.status !== 0 || prefix.status !== 0) return null;
  const file = path.resolve(root, excludePath.stdout.trim());
  const base = `/${prefix.stdout.trim()}`.replace(/\/$/, '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const added = patterns.map((p) => `${base}${p}`).filter((p) => !lines.has(p));
  if (added.length) fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# ai-workflow (로컬 전용)\n${added.join('\n')}\n`);
  return added;
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

// 파일마다 쓸 내용. 기본값도 적어 무엇이 쓰이는지 보이게 한다. 알 수 없는 키는 버리지 않고 남겨 사용자가 확인하게 한다.
function serializeScope(scope, stored, header) {
  const sections = CONFIG_SECTIONS.filter((s) => s.scope === scope);
  const known = Object.fromEntries(sections.flatMap((s) => s.keys).map((k) => [k.name, stored[k.name] || k.default || '']));
  const unknownKeys = Object.keys(stored).filter((name) => !configKey(name));
  let content = serializeEnv(sections, known, { header });
  if (unknownKeys.length) {
    content += `\n# ===== 알 수 없는 키 (확인 후 지운다) =====\n${unknownKeys.map((k) => `${k}=${quoteValue(stored[k])}`).join('\n')}\n`;
  }
  return content;
}

// 예전 형식(.env 하나에 모든 값)을 나눈다: 프로젝트 값 → project.env, 개인 값 → 개인 설정.
// 개인 설정에 이미 다른 값이 있으면 .env 에 이 프로젝트 전용 덮어쓰기로 남긴다.
function migrate(stores) {
  const moved = [];
  for (const [name, value] of Object.entries(stores.local)) {
    const key = configKey(name);
    if (!key) continue;
    if (key.scope === 'project') {
      if (!stores.project[name]) stores.project[name] = value;
      delete stores.local[name];
      if (value) moved.push(`${name} → project.env`);
    } else if (!stores.user[name] || stores.user[name] === value) {
      if (!stores.user[name] && value) moved.push(`${name} → 개인 설정`);
      if (value) stores.user[name] = value;
      delete stores.local[name];
    }
  }
  for (const [name, value] of Object.entries(stores.project)) {
    if (configKey(name)?.scope !== 'user') continue;
    if (!stores.user[name] && value) stores.user[name] = value;
    delete stores.project[name];
    moved.push(`${name} → 개인 설정 (project.env 에서 뺌)`);
  }
  return moved;
}

const tilde = (file) => {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}`.split(path.sep).join('/') : file;
};

export async function cmdInit(ctx, opts) {
  return withLock(ctx, 'init', async () => {
    fs.mkdirSync(path.join(ctx.workflowRoot, 'features'), { recursive: true });
    const addedIgnore = ensureGitignore(ctx.workflowRoot);
    writeEnvExample(ctx.workflowRoot);
    stampProjectVersion(ctx.workflowRoot);
    // 플러그인이면 프로젝트에 생기는 것은 .ai-workflow/ 뿐이다.
    const localExcludes = opts.local ? addLocalExcludes(ctx.projectRoot, ['/.ai-workflow/']) : undefined;

    const before = ctx.reloadConfig();
    const { files } = before;
    const userExisted = fs.existsSync(files.user);
    const stores = {
      project: { ...readEnvFile(files.project).values },
      user: { ...readEnvFile(files.user).values },
      local: { ...readEnvFile(files.local).values },
    };
    const moved = migrate(stores);
    // 값의 저장 위치: 프로젝트 항목은 project.env, 개인 항목은 개인 설정 (--override 면 이 프로젝트의 .env).
    const store = (name, value) => {
      if (configKey(name).scope === 'project') {
        stores.project[name] = value;
      } else if (opts.override) {
        stores.local[name] = value;
      } else {
        stores.user[name] = value;
        delete stores.local[name];
      }
    };
    for (const [name, value] of Object.entries(parseSetOptions(opts.set))) store(name, value);

    const effective = () => {
      const merged = {};
      for (const key of CONFIG_KEYS) {
        const order = key.scope === 'project' ? [stores.project] : [stores.local, stores.user];
        merged[key.name] = order.map((s) => s[key.name]).find((v) => v) ?? '';
      }
      return merged;
    };
    const interactive = ctx.stdinIsTTY && !opts['non-interactive'];
    if (interactive) {
      const values = effective();
      const invalid = (k) => validateConfig(values).errors.some((e) => e.key === k.name);
      // 처음이면(프로젝트 설정 또는 개인 설정이 없음) 그 구간을 모두 묻고, 이후에는 빠지거나 잘못된 항목만 묻는다.
      const fresh = { project: !before.projectExists && !before.needsMigration, user: !userExisted && !moved.length };
      const pending = CONFIG_KEYS.filter((k) => opts.all || fresh[k.scope] || invalid(k));
      await askInteractively(ctx, values, pending);
      // Slack 을 켰으면 그 뒤에 필요해진 항목을 다시 확인한다.
      const stillMissing = CONFIG_KEYS.filter(invalid);
      if (stillMissing.length) await askInteractively(ctx, values, stillMissing);
      for (const key of new Set([...pending, ...stillMissing])) store(key.name, values[key.name]);
    }

    writeEnvFile(files.project, serializeScope('project', stores.project, PROJECT_HEADER));
    writeEnvFile(files.user, serializeScope('user', stores.user, USER_HEADER));
    const overrides = Object.entries(stores.local).filter(([, v]) => v !== '');
    if (overrides.length) {
      writeEnvFile(files.local, `${[...LOCAL_HEADER.map((l) => `# ${l}`), ...overrides.map(([k, v]) => `${k}=${quoteValue(v)}`)].join('\n')}\n`);
    } else if (fs.existsSync(files.local)) {
      fs.rmSync(files.local);
    }
    const after = ctx.reloadConfig();

    const ignore = checkEnvIgnored(ctx);
    const lines = [];
    if (addedIgnore.length) lines.push(`.ai-workflow/.gitignore 에 추가: ${addedIgnore.join(', ')}`);
    if (localExcludes === null) lines.push('[주의] git 저장소가 아니라 로컬 git 제외를 넣지 못했다');
    else if (localExcludes) lines.push(`로컬 git 제외(.git/info/exclude): ${localExcludes.length ? localExcludes.join(' ') : '이미 있음'}`);
    if (moved.length) lines.push(`예전 .env 에서 옮김: ${moved.join(', ')}`);
    lines.push(`프로젝트 설정(커밋 대상): ${path.relative(ctx.projectRoot, files.project).split(path.sep).join('/')}`);
    lines.push(`개인 설정(이 PC 공통): ${tilde(files.user)}`);
    if (overrides.length) lines.push(`이 프로젝트 전용 개인 설정: .ai-workflow/.env (${overrides.map(([k]) => k).join(', ')})`);
    lines.push(`.env git 제외 상태: ${describeIgnore(ignore.state)}`);
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
    // project: 팀 공통(project.env, 커밋). user: 개인(이 PC 의 모든 프로젝트 공통).
    scope: section.scope,
    keys: section.keys.map((k) => ({
      key: k.name,
      question: k.question,
      description: k.description ?? null,
      default: k.default ?? null,
      required: isRequired(k, config.values),
      filled: Boolean(config.raw[k.name]),
      source: config.sources[k.name] ?? null,
      error: config.errors.find((e) => e.key === k.name)?.message ?? null,
    })),
  }));
  return { ok: true, message: JSON.stringify(items, null, 2) };
}
