// 프로젝트·개인 설정 스키마. 모든 값은 .ai-workflow/.env 한 파일에 두고 git 에서 제외한다.
// 엔진 코드와 템플릿에는 프로젝트 이름·회사 문구·Slack ID·PC 경로를 넣지 않는다. 항상 여기서 읽는다.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkflowError } from './util.mjs';
import { readEnvFile } from './envfile.mjs';

export const ENV_FILE = '.env';
export const ENV_EXAMPLE_FILE = '.env.example';

const SLACK_ON = (values) => values.AIWF_SLACK_ENABLED === 'true';

// required: true | (values) => boolean. ask: init 질의 여부.
export const CONFIG_SECTIONS = [
  {
    title: '프로젝트',
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
    title: '이 PC',
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
        name: 'AIWF_REVIEW_MODEL',
        question: '검수에 쓸 Codex 모델 ID는? (예: gpt-6.1-sol)',
        description: '독립 검수 Codex 모델 ID.',
        default: 'gpt-6.1-sol',
        required: true,
        validate: (v) => (/^[a-z0-9][a-z0-9.-]{1,60}$/.test(v) ? null : '소문자·숫자·점·하이픈 모델 ID'),
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
    ],
  },
  {
    title: '알림 (Slack, 선택)',
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

function isRequired(key, values) {
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

// .env 를 읽어 검증한다. 파일이 없거나 오류가 있어도 던지지 않는다 (status/init 이 보여준다).
export function loadConfig(workflowRoot) {
  const file = envPath(workflowRoot);
  const { exists, values: raw, duplicates } = readEnvFile(file);
  const { values, errors } = validateConfig(raw);
  for (const d of duplicates) errors.push({ key: d, code: 'DUPLICATE', message: '같은 키가 여러 번 있다' });
  return { file, exists, raw, values, errors };
}

// 실제 작업 명령 전에 호출한다. 설정이 불완전하면 무엇이 빠졌는지와 함께 차단한다.
export function requireValidConfig(ctx) {
  const config = ctx.config;
  if (!config.exists) {
    throw new WorkflowError('CONFIG_MISSING', '.ai-workflow/.env 가 없다. 먼저 init 으로 설정을 채운다.', { exitCode: 3 });
  }
  if (config.errors.length) {
    const lines = config.errors.map((e) => `${e.key}: ${e.message}`);
    throw new WorkflowError('CONFIG_INVALID', `.ai-workflow/.env 설정 오류 — init 으로 고친다.\n  ${lines.join('\n  ')}`, {
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
