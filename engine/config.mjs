// 프로젝트·개인 설정 스키마. 값은 세 파일에 나눠 둔다.
// - 프로젝트 공통(scope: project): .ai-workflow/project.env — 커밋해서 팀이 같은 값을 쓴다. 프로젝트에서 처음 설정하는 사람이 한 번 채운다.
// - 개인(scope: user): ~/.ai-workflow/user.env — 이 PC 의 모든 프로젝트에 쓰는 경로·Slack 값. git 밖.
// - 개인 덮어쓰기: .ai-workflow/.env — 이 프로젝트에서만 개인 값을 바꿀 때. git 제외.
// 엔진 코드와 템플릿에는 프로젝트 이름·회사 문구·Slack ID·PC 경로를 넣지 않는다. 항상 여기서 읽는다.
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkflowError } from './util.mjs';
import { readEnvFile } from './envfile.mjs';

export const ENV_FILE = '.env';
export const ENV_EXAMPLE_FILE = '.env.example';
export const PROJECT_ENV_FILE = 'project.env';

// 개인 설정 파일. AIWF_USER_CONFIG 로 바꿀 수 있다 (테스트·여러 계정).
export function defaultUserConfigFile(env = process.env) {
  return env.AIWF_USER_CONFIG || path.join(os.homedir(), '.ai-workflow', 'user.env');
}

const SLACK_ON = (values) => values.AIWF_SLACK_ENABLED === 'true';

// required: true | (values) => boolean. ask: init 질의 여부.
export const CONFIG_SECTIONS = [
  {
    title: '프로젝트',
    scope: 'project',
    keys: [
      {
        name: 'AIWF_PROJECT_NAME',
        question: '프로젝트 이름은 무엇인가요?',
        description: '프로젝트 이름. 문서 머리말·알림·개발 지시문에 쓴다.',
        required: true,
        validate: (v) => (v.length <= 100 ? null : '100자 이하'),
      },
      {
        name: 'AIWF_PROJECT_SUMMARY',
        question: '프로젝트를 한두 문장으로 설명해 주세요. (없으면 비워 둠)',
        description: '프로젝트 한 줄 설명. 개발·검수 지시문의 배경으로 쓴다.',
        validate: (v) => (v.length <= 500 ? null : '500자 이하'),
      },
      {
        name: 'AIWF_ORGANIZATION',
        question: '회사·조직 이름은 무엇인가요? (없으면 비워 둠)',
        description: '회사·조직 이름.',
        validate: (v) => (v.length <= 100 ? null : '100자 이하'),
      },
      {
        name: 'AIWF_ORGANIZATION_NOTICE',
        question: '문서에 넣을 회사 문구가 있나요? 예: 저작권·보안 등급 표기 (없으면 비워 둠)',
        description: '문서 끝에 넣는 회사 문구 (저작권·보안 등급 등).',
        validate: (v) => (v.length <= 500 ? null : '500자 이하'),
      },
      {
        name: 'AIWF_DOC_LANGUAGE',
        question: '문서·보고 언어는 무엇인가요? (ko 또는 en)',
        description: '문서·보고 언어: ko | en',
        default: 'ko',
        required: true,
        validate: (v) => (['ko', 'en'].includes(v) ? null : 'ko 또는 en'),
      },
      {
        name: 'AIWF_DOCS_DIR',
        question: '기능 문서를 둘 폴더는 어디인가요? (프로젝트 루트 기준 상대 경로)',
        description: '기능 완료 후 문서를 쓰는 폴더. 프로젝트 루트 기준 상대 경로.',
        default: 'docs',
        required: true,
        validate: validateRelativeDir,
      },
    ],
  },
  {
    title: '검수',
    scope: 'project',
    keys: [
      {
        name: 'AIWF_REVIEW_MODEL',
        question: '검수에 쓸 Codex 모델 ID는? (예: gpt-6.1-sol)',
        description: '독립 검수 Codex 모델 ID.',
        default: 'gpt-6.1-sol',
        required: true,
        validate: (v) => (/^[a-z0-9][a-z0-9.-]{1,60}$/.test(v) ? null : '소문자·숫자·점·하이픈 모델 ID'),
      },
      {
        name: 'AIWF_REVIEW_AUTH',
        question: '검수 Codex 인증 방식은? (chatgpt: ChatGPT 구독 로그인만 허용, any: API 키도 허용)',
        description: '검수 Codex 인증: chatgpt (ChatGPT 로그인이 아니면 검수를 막고 API 키 환경변수를 넘기지 않는다) | any',
        default: 'chatgpt',
        required: true,
        validate: (v) => (['chatgpt', 'any'].includes(v) ? null : 'chatgpt 또는 any'),
      },
    ],
  },
  {
    title: '자율 진행',
    scope: 'project',
    keys: [
      {
        name: 'AIWF_AUTO_MAX_REVIEW_ROUNDS',
        question: '자율 진행 중 Codex 검수 지적을 몇 번까지 master 가 고치게 할까요? (넘으면 사용자를 부름)',
        description: '자율 진행: 검수 지적 반복 상한. 넘으면 사용자를 부른다.',
        default: '3',
        required: true,
        validate: (v) => (/^(10|[1-9])$/.test(v) ? null : '1~10'),
      },
      {
        name: 'AIWF_AUTO_MAX_VERIFY_FAILURES',
        question: '자율 진행 중 검증 실패를 몇 번까지 master 가 고치게 할까요? (넘으면 사용자를 부름)',
        description: '자율 진행: 연속 검증 실패 상한. 넘으면 사용자를 부른다.',
        default: '3',
        required: true,
        validate: (v) => (/^(10|[1-9])$/.test(v) ? null : '1~10'),
      },
    ],
  },
  {
    title: '이 PC',
    scope: 'user',
    keys: [
      {
        name: 'AIWF_CLAUDE_BIN',
        question: 'claude 실행 파일 경로는? (PATH 에 있으면 claude 그대로)',
        description: 'Claude Code CLI 실행 파일. PATH 의 명령 이름 또는 절대 경로.',
        default: 'claude',
        required: true,
        validate: validateExecutable,
      },
      {
        name: 'AIWF_CODEX_BIN',
        question: 'codex 실행 파일 경로는? (PATH 에 있으면 codex 그대로)',
        description: 'Codex CLI 실행 파일 (독립 검수용). PATH 의 명령 이름 또는 절대 경로.',
        default: 'codex',
        required: true,
        validate: validateExecutable,
      },
      {
        name: 'AIWF_PLAYWRIGHT_MODULE',
        question: '브라우저 테스트용 playwright 모듈 폴더 절대 경로는? (브라우저 테스트를 안 쓰면 비워 둠)',
        description: '브라우저 테스트에 쓸 playwright 모듈 폴더 절대 경로. 비우면 브라우저 테스트를 쓰지 않는다.',
        validate: (v) => validateAbsolutePath(v),
      },
      {
        name: 'AIWF_BROWSER_CHANNEL',
        question: '브라우저 채널은? (msedge, chrome, chromium 중 하나. 비우면 chromium)',
        description: '브라우저 테스트 채널: msedge | chrome | chromium',
        validate: (v) => (['msedge', 'chrome', 'chromium'].includes(v) ? null : 'msedge, chrome, chromium 중 하나'),
      },
      {
        name: 'AIWF_REVIEW_BROWSER',
        question: 'Codex 검수 때 브라우저로 화면을 직접 확인하게 할까요? (chrome, msedge 중 하나. 비우면 안 씀)',
        description: 'Codex 검수자가 쓸 브라우저 (Playwright MCP, headless): chrome | msedge. 비우면 코드만 본다.',
        validate: (v) => (['chrome', 'msedge'].includes(v) ? null : 'chrome, msedge 중 하나'),
      },
    ],
  },
  {
    title: '알림 (Slack, 선택)',
    scope: 'user',
    keys: [
      {
        name: 'AIWF_SLACK_ENABLED',
        question: 'Slack DM 으로 진행 상황을 받을까요? (true 또는 false)',
        description: 'Slack 봇 DM 보고 사용 여부: true | false',
        default: 'false',
        required: true,
        validate: (v) => (['true', 'false'].includes(v) ? null : 'true 또는 false'),
      },
      {
        name: 'AIWF_SLACK_LEVEL',
        question: 'Slack 알림을 얼마나 받을까요? (all: 모든 단계 진행, important: 기능 시작·완료와 확인 필요·오류만)',
        description: 'Slack 알림 수준: all (모든 단계 진행) | important (기능 시작·완료, 확인 필요, 오류만)',
        default: 'all',
        required: SLACK_ON,
        validate: (v) => (['all', 'important'].includes(v) ? null : 'all 또는 important'),
      },
      {
        name: 'AIWF_SLACK_SCREENSHOTS',
        question: 'Slack 알림에 화면 캡처를 붙일까요? (off: 안 붙임, failures: 테스트 실패 화면만, all: 시안·완료 보고 화면까지)',
        description: 'Slack 화면 캡처 첨부: off | failures (테스트 실패만) | all (시안·완료 보고 포함). 화면에 실제 데이터가 보일 수 있다. Slack 앱에 files:write 권한이 필요하다.',
        default: 'off',
        required: SLACK_ON,
        validate: (v) => (['off', 'failures', 'all'].includes(v) ? null : 'off, failures, all 중 하나'),
      },
      {
        name: 'AIWF_SLACK_WORKSPACE',
        question: 'Slack 워크스페이스 주소는? (예: example.slack.com)',
        description: 'Slack 워크스페이스 주소 (표시용).',
        required: SLACK_ON,
        validate: (v) => (/^[a-z0-9-]+\.slack\.com$/.test(v) ? null : '<이름>.slack.com 형식'),
      },
      {
        name: 'AIWF_SLACK_USER_ID',
        question: '알림을 받을 Slack 사용자 ID는? (U 로 시작)',
        description: '알림을 받을 Slack 사용자 ID.',
        required: SLACK_ON,
        validate: (v) => (/^[UW][A-Z0-9]{6,20}$/.test(v) ? null : 'U 또는 W 로 시작하는 대문자·숫자'),
      },
      {
        name: 'AIWF_SLACK_CHANNEL_ID',
        question: '봇 DM 채널 ID는? (D 로 시작)',
        description: '봇 DM 채널 ID.',
        required: SLACK_ON,
        validate: (v) => (/^[DCG][A-Z0-9]{6,20}$/.test(v) ? null : 'D·C·G 로 시작하는 대문자·숫자'),
      },
      {
        name: 'AIWF_SLACK_TOKEN_FILE',
        question: '암호화된 Slack 봇 토큰 파일의 절대 경로는? (토큰 값 자체는 넣지 않습니다)',
        description: '암호화된 Slack 봇 토큰 파일의 절대 경로. 토큰 값 자체는 이 파일에 넣지 않는다.',
        required: SLACK_ON,
        validate: (v) => validateAbsolutePath(v),
      },
    ],
  },
];

for (const section of CONFIG_SECTIONS) for (const key of section.keys) key.scope = section.scope;
export const CONFIG_KEYS = CONFIG_SECTIONS.flatMap((s) => s.keys);
const KEY_BY_NAME = new Map(CONFIG_KEYS.map((k) => [k.name, k]));

export function configKey(name) {
  return KEY_BY_NAME.get(name) ?? null;
}

function validateRelativeDir(v) {
  if (path.isAbsolute(v) || /^[a-zA-Z]:/.test(v)) return '상대 경로';
  if (v.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) return '.. 이나 빈 구간 없는 상대 경로';
  if (/^\.ai-workflow([\\/]|$)/i.test(v)) return '.ai-workflow 밖의 폴더';
  return null;
}

function validateAbsolutePath(v) {
  return path.isAbsolute(v) ? null : '절대 경로';
}

function validateExecutable(v) {
  if (path.isAbsolute(v)) return null;
  return /^[A-Za-z0-9_.-]+$/.test(v) ? null : 'PATH 의 명령 이름 또는 절대 경로';
}

// 토큰·비밀번호 형태의 값은 어떤 키에도 받지 않는다. 이 파일에는 비밀값의 "경로"만 둔다.
const SECRET_VALUE_PATTERNS = [
  /xox[abposre]-[A-Za-z0-9-]{8,}/,
  /xapp-[A-Za-z0-9-]{8,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
];

export function looksLikeSecret(value) {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

export function isRequired(key, values) {
  return typeof key.required === 'function' ? key.required(values) : key.required === true;
}

// 기본값을 채운 값과 오류 목록을 돌려준다. 오류: { key, code, message }
export function validateConfig(rawValues) {
  const errors = [];
  const values = {};
  for (const key of CONFIG_KEYS) {
    const raw = rawValues[key.name];
    values[key.name] = raw === undefined || raw === '' ? key.default ?? '' : raw;
  }
  for (const name of Object.keys(rawValues)) {
    if (!KEY_BY_NAME.has(name)) errors.push({ key: name, code: 'UNKNOWN_KEY', message: '알 수 없는 키 (이 파일은 워크플로 설정 전용)' });
  }
  for (const key of CONFIG_KEYS) {
    const value = values[key.name];
    if (value === '') {
      if (isRequired(key, values)) errors.push({ key: key.name, code: 'MISSING', message: key.question });
      continue;
    }
    if (looksLikeSecret(value)) {
      errors.push({ key: key.name, code: 'SECRET_VALUE', message: '토큰·비밀값으로 보인다. 비밀값은 넣지 않고 암호화된 파일 경로만 둔다' });
      continue;
    }
    if (/[\r\n]/.test(value)) {
      errors.push({ key: key.name, code: 'INVALID', message: '여러 줄 값은 받지 않는다' });
      continue;
    }
    const problem = key.validate?.(value);
    if (problem) errors.push({ key: key.name, code: 'INVALID', message: `형식 오류: ${problem}` });
  }
  return { values, errors };
}

export function envPath(workflowRoot) {
  return path.join(workflowRoot, ENV_FILE);
}

export function configFiles(workflowRoot, userFile = defaultUserConfigFile()) {
  return { project: path.join(workflowRoot, PROJECT_ENV_FILE), user: userFile, local: envPath(workflowRoot) };
}

// 키마다 값을 읽을 파일 순서. 프로젝트 값은 project.env 에서만 읽는다 (사람마다 달라지지 않게).
// 예전 형식(모든 값이 .env 하나)의 프로젝트 값은 init 이 project.env 로 옮길 때까지 읽어 준다(legacy).
const SOURCES = { project: ['project', 'legacy'], user: ['local', 'user'] };
const SOURCE_FILE = { project: 'project', legacy: 'local', local: 'local', user: 'user' };

// 세 파일을 읽어 합치고 검증한다. 파일이 없거나 오류가 있어도 던지지 않는다 (status/init 이 보여준다).
// 반환 sources: 키마다 값을 읽은 곳 (project | user | local | legacy).
export function loadConfig(workflowRoot, { userFile } = {}) {
  const files = configFiles(workflowRoot, userFile);
  const read = { project: readEnvFile(files.project), user: readEnvFile(files.user), local: readEnvFile(files.local) };
  const raw = {};
  const sources = {};
  for (const key of CONFIG_KEYS) {
    for (const source of SOURCES[key.scope]) {
      const value = read[SOURCE_FILE[source]].values[key.name];
      if (value !== undefined && value !== '') {
        raw[key.name] = value;
        sources[key.name] = source;
        break;
      }
    }
  }
  const unknown = new Set();
  for (const file of Object.values(read)) for (const name of Object.keys(file.values)) if (!KEY_BY_NAME.has(name)) unknown.add(name);
  for (const name of unknown) raw[name] = '';
  const { values, errors } = validateConfig(raw);
  for (const [name, file] of Object.entries(read)) {
    for (const d of file.duplicates) errors.push({ key: d, code: 'DUPLICATE', message: `같은 키가 여러 번 있다 (${name})` });
  }
  // 개인 값(경로·Slack ID)이 커밋되는 project.env 에 있으면 init 으로 개인 설정으로 옮긴다.
  for (const name of Object.keys(read.project.values)) {
    if (KEY_BY_NAME.get(name)?.scope === 'user') errors.push({ key: name, code: 'MISPLACED', message: '개인 설정이 project.env 에 있다. init 이 개인 설정으로 옮긴다' });
  }
  return {
    file: files.local,
    files,
    // 프로젝트 설정이 있으면 설정된 것으로 본다. 개인 값은 모두 기본값이 있어 비어 있어도 된다.
    exists: read.project.exists || read.local.exists,
    projectExists: read.project.exists,
    needsMigration: Object.values(sources).includes('legacy'),
    raw,
    values,
    errors,
    sources,
  };
}

// 실제 작업 명령 전에 호출한다. 설정이 불완전하면 무엇이 빠졌는지와 함께 차단한다.
export function requireValidConfig(ctx) {
  const config = ctx.config;
  if (!config.exists) {
    throw new WorkflowError('CONFIG_MISSING', '프로젝트 설정(.ai-workflow/project.env)이 없다. 먼저 init 으로 설정을 채운다.', { exitCode: 3 });
  }
  if (config.errors.length) {
    const lines = config.errors.map((e) => `${e.key}: ${e.message}`);
    throw new WorkflowError('CONFIG_INVALID', `설정 오류 — init 으로 고친다.\n  ${lines.join('\n  ')}`, {
      exitCode: 3,
      details: { errors: config.errors },
    });
  }
  return config.values;
}

// ---------- git 제외 확인 ----------

export function defaultGit(projectRoot, args) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', projectRoot, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    windowsHide: true,
  });
  if (result.error) return { status: null, stdout: '', stderr: String(result.error.code ?? result.error.message) };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// 반환 state: IGNORED | NOT_IGNORED | TRACKED | NO_GIT | GIT_UNAVAILABLE
export function checkEnvIgnored(ctx) {
  const relPath = '.ai-workflow/.env';
  const inside = ctx.git(ctx.projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status === null) return { state: 'GIT_UNAVAILABLE' };
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { state: 'NO_GIT' };
  const tracked = ctx.git(ctx.projectRoot, ['ls-files', '--error-unmatch', '--', relPath]);
  if (tracked.status === 0) return { state: 'TRACKED' };
  const ignored = ctx.git(ctx.projectRoot, ['check-ignore', '-q', '--', relPath]);
  return { state: ignored.status === 0 ? 'IGNORED' : 'NOT_IGNORED' };
}

// git 저장소인데 .env 가 커밋 대상이 될 수 있으면 차단한다. git 저장소가 아니면 상태만 돌려준다.
export function requireEnvIgnored(ctx) {
  const result = checkEnvIgnored(ctx);
  if (result.state === 'TRACKED') {
    throw new WorkflowError('ENV_TRACKED', '.ai-workflow/.env 가 git 에 추적되고 있다. `git rm --cached .ai-workflow/.env` 로 추적을 해제한다.', { exitCode: 3 });
  }
  if (result.state === 'NOT_IGNORED') {
    throw new WorkflowError('ENV_NOT_IGNORED', '.ai-workflow/.env 가 git 에서 제외되지 않는다. .ai-workflow/.gitignore 를 확인한다 (init 이 다시 만든다).', { exitCode: 3 });
  }
  return result;
}
