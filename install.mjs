#!/usr/bin/env node
// 프로젝트에 ai-workflow 를 설치한다: <프로젝트>/.ai-workflow/{engine,templates} 복사, .gitignore·.env.example 생성.
// Claude Code 단계별 스킬(.claude/skills/aiwf*)과 파일 수정 범위 훅(.claude/settings.json)도 등록한다.
// Claude Code 플러그인으로 쓰면 이 설치는 필요 없다 (README 의 "플러그인으로 쓰기").
// 사용: node install.mjs <프로젝트 루트> [--upgrade] [--no-claude] [--local]
//   --upgrade   : 이미 설치된 프로젝트의 엔진·스킬만 교체한다. features/·runs/·.env·직접 고친 템플릿은 건드리지 않는다.
//   --no-claude : .claude/ 아래(스킬·훅)는 건드리지 않는다.
//   --local     : 저장소에 흔적을 남기지 않는다 (.git/info/exclude 에 제외 추가).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureGitignore, writeEnvExample, addLocalExcludes } from './engine/init.mjs';
import { ENGINE_VERSION } from './engine/version.mjs';

const FRAMEWORK_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = '.ai-workflow';
const SKILL_PREFIX = 'aiwf';
export const HOOK_MARKER = '.ai-workflow/engine/hook.mjs';
export const HOOK_ENTRY = {
  matcher: 'Edit|Write|MultiEdit|NotebookEdit',
  hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.ai-workflow/engine/hook.mjs"' }],
};

function copyDir(from, to, { overwrite }) {
  const copied = [];
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyDir(source, target, { overwrite }));
    } else if (entry.isFile()) {
      if (!overwrite && fs.existsSync(target)) continue;
      fs.copyFileSync(source, target);
      copied.push(target);
    }
  }
  return copied;
}

// 스킬 원본은 플러그인 경로(${CLAUDE_PLUGIN_ROOT})로 엔진을 부른다. 프로젝트 설치에서는 .ai-workflow/ 경로로 바꾼다.
export function toProjectSkill(text) {
  return text.replaceAll('node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs"', 'node .ai-workflow/engine/cli.mjs')
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/templates/', '.ai-workflow/templates/');
}

// 프레임워크의 스킬을 .claude/skills/ 에 덮어쓴다. 프레임워크에서 사라진 aiwf* 스킬은 지운다.
function installSkills(root) {
  const source = path.join(FRAMEWORK_ROOT, 'skills');
  const target = path.join(root, '.claude', 'skills');
  const names = fs.readdirSync(source, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  if (fs.existsSync(target)) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(SKILL_PREFIX) && !names.includes(entry.name)) {
        fs.rmSync(path.join(target, entry.name), { recursive: true });
      }
    }
  }
  for (const name of names) {
    fs.rmSync(path.join(target, name), { recursive: true, force: true });
    for (const file of copyDir(path.join(source, name), path.join(target, name), { overwrite: true })) {
      if (file.endsWith('.md')) fs.writeFileSync(file, toProjectSkill(fs.readFileSync(file, 'utf8')));
    }
  }
  return names;
}

// .claude/settings.json 의 PreToolUse 에 범위 훅을 한 번만 추가한다. 다른 설정은 그대로 둔다.
// 반환: 'added' | 'present' | 'invalid'
export function registerHook(root) {
  const file = path.join(root, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return 'invalid';
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'invalid';
  }
  settings.hooks ??= {};
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return 'invalid';
  settings.hooks.PreToolUse ??= [];
  if (!Array.isArray(settings.hooks.PreToolUse)) return 'invalid';
  const present = settings.hooks.PreToolUse.some((entry) => (entry?.hooks ?? [])
    .some((hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER)));
  if (present) return 'present';
  settings.hooks.PreToolUse.push(HOOK_ENTRY);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return 'added';
}

const LINTER_CONFIGS = [
  ['eslint', /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/],
  ['prettier', /^(prettier\.config\.[cm]?[jt]s|\.prettierrc(\.[a-z]+)?)$/],
  ['biome', /^biome\.jsonc?$/],
];

// 프로젝트 린터가 엔진 파일까지 검사하면 프로젝트 검사(checks)가 엔진 때문에 실패한다.
export function lintersNeedingIgnore(root) {
  const names = fs.readdirSync(root);
  return LINTER_CONFIGS
    .filter(([, pattern]) => names.some((n) => pattern.test(n) && !fs.readFileSync(path.join(root, n), 'utf8').includes('.ai-workflow')))
    .map(([tool]) => tool);
}

const LOCAL_EXCLUDES = ['/.ai-workflow/', '/.claude/settings.json', '/.claude/skills/aiwf*/'];

export function install(projectRoot, { upgrade = false, claude = true, local = false } = {}) {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`프로젝트 폴더가 없다: ${root}`);
  if (path.resolve(root) === FRAMEWORK_ROOT) throw new Error('프레임워크 저장소 자신에는 설치하지 않는다.');
  const workflowRoot = path.join(root, WORKFLOW_DIR);
  const engineDir = path.join(workflowRoot, 'engine');
  const installed = fs.existsSync(engineDir);
  if (installed && !upgrade) throw new Error(`이미 설치되어 있다: ${engineDir}. 엔진만 교체하려면 --upgrade 를 붙인다.`);
  if (!installed && upgrade) throw new Error('설치된 엔진이 없다. --upgrade 없이 설치한다.');

  if (installed) fs.rmSync(engineDir, { recursive: true });
  const engine = copyDir(path.join(FRAMEWORK_ROOT, 'engine'), engineDir, { overwrite: true });
  // 템플릿은 프로젝트에서 고쳐 쓸 수 있으므로 기존 파일을 덮어쓰지 않는다.
  const templates = copyDir(path.join(FRAMEWORK_ROOT, 'templates'), path.join(workflowRoot, 'templates'), { overwrite: false });
  fs.mkdirSync(path.join(workflowRoot, 'features'), { recursive: true });
  fs.writeFileSync(path.join(workflowRoot, 'VERSION'), `${ENGINE_VERSION}\n`);
  const ignoreAdded = ensureGitignore(workflowRoot);
  writeEnvExample(workflowRoot);
  const skills = claude ? installSkills(root) : [];
  const hook = claude ? registerHook(root) : 'disabled';
  const localExcludes = local ? addLocalExcludes(root, LOCAL_EXCLUDES) : null;
  return { workflowRoot, upgraded: installed, engineFiles: engine.length, templateFiles: templates.length, ignoreAdded, version: ENGINE_VERSION, skills, hook, linters: lintersNeedingIgnore(root), local, localExcludes };
}

const HOOK_MESSAGES = {
  added: '.claude/settings.json 에 파일 수정 범위 훅을 추가했다',
  present: '파일 수정 범위 훅은 이미 등록돼 있다',
  invalid: '[주의] .claude/settings.json 을 해석할 수 없어 훅을 등록하지 못했다. README 의 훅 설정을 직접 넣는다',
  disabled: '.claude/ 는 건드리지 않았다 (--no-claude)',
};

function main(argv) {
  const flags = ['--upgrade', '--no-claude', '--local'];
  const args = argv.filter((a) => !flags.includes(a));
  if (args.length !== 1 || args[0].startsWith('--')) {
    process.stderr.write('사용: node install.mjs <프로젝트 루트> [--upgrade] [--no-claude] [--local]\n');
    return 2;
  }
  try {
    const r = install(args[0], { upgrade: argv.includes('--upgrade'), claude: !argv.includes('--no-claude'), local: argv.includes('--local') });
    process.stdout.write([
      `${r.upgraded ? '엔진 교체' : '설치'} 완료 (v${r.version}): ${r.workflowRoot}`,
      `  엔진 파일 ${r.engineFiles}개, 새 템플릿 ${r.templateFiles}개${r.ignoreAdded.length ? `, .gitignore 추가: ${r.ignoreAdded.join(' ')}` : ''}`,
      ...(r.skills.length ? [`  스킬: ${r.skills.map((n) => `.claude/skills/${n}`).join(', ')}`] : []),
      `  ${HOOK_MESSAGES[r.hook]}`,
      ...(r.local ? [r.localExcludes === null ? '  [주의] git 저장소가 아니라 로컬 git 제외를 넣지 못했다' : `  로컬 git 제외(.git/info/exclude): ${r.localExcludes.length ? r.localExcludes.join(' ') : '이미 있음'}`] : []),
      ...(r.linters.length ? [r.local
        ? `  [주의] ${r.linters.join(', ')} 가 .ai-workflow/ 도 검사한다. 로컬 전용이므로 린터 설정은 두고 checks.json 의 린트 명령에서 제외한다 (예: npx eslint . --ignore-pattern ".ai-workflow/**")`
        : `  [주의] ${r.linters.join(', ')} 설정에 .ai-workflow/ 제외가 없다. 엔진 파일까지 검사하면 프로젝트 검사가 실패하므로 제외 목록에 .ai-workflow/ 를 넣는다`] : []),
      '',
      '다음 단계 (프로젝트 루트에서):',
      '  node .ai-workflow/engine/cli.mjs init      # 설정 질의 → .ai-workflow/project.env(커밋) + ~/.ai-workflow/user.env(개인)',
      '  node .ai-workflow/engine/cli.mjs status',
      '  또는 프로젝트 루트에서 Claude Code 를 열고 /aiwf 로 시작한다',
      '',
    ].join('\n'));
    return 0;
  } catch (e) {
    process.stderr.write(`[INSTALL_FAILED] ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
