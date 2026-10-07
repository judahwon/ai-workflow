import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../engine/cli.mjs';
import { checkAllowedPattern, orderTasks } from '../engine/tasks.mjs';
import { readVersion, readOpenQuestions } from '../engine/documents.mjs';
import { install, registerHook, HOOK_MARKER } from '../install.mjs';
import { setupProject } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('parseArgs: 반복 옵션·중복·알 수 없는 옵션', () => {
  assert.deepEqual(parseArgs(['init', '--set', 'A=1', '--set=B=2']).opts, { set: ['A=1', 'B=2'] });
  assert.throws(() => parseArgs(['new', '--title', 'a', '--title', 'b']), /중복/);
  assert.throws(() => parseArgs(['new', '--nope']), /없는 옵션/);
  assert.throws(() => parseArgs(['approve', '--user-confirmed=yes']), /값을 받지 않는다/);
  assert.equal(parseArgs([]).command, 'help');
});

test('checkAllowedPattern', () => {
  for (const ok of ['src/a.ts', 'src/pages/**', 'src/*.tsx', 'docs/x.md', 'build.gradle']) assert.equal(checkAllowedPattern(ok), null, ok);
  for (const bad of ['', '/abs', 'C:/x', '../x', 'a//b', 'a\\b', '**', '*/**', '.git/config', '.ai-workflow/x', 'node_modules/a', 'src/.env', 'src/a**b', ' src/a']) {
    assert.notEqual(checkAllowedPattern(bad), null, bad);
  }
});

test('orderTasks: 의존 순서, 독립 작업은 목록 순서 유지', () => {
  assert.deepEqual(orderTasks([
    { id: 'TASK-001', dependsOn: ['TASK-003'] },
    { id: 'TASK-002' },
    { id: 'TASK-003' },
  ]), ['TASK-003', 'TASK-001', 'TASK-002']);
  assert.throws(() => orderTasks([{ id: 'TASK-001', dependsOn: ['TASK-009'] }]), /목록에 없다/);
});

test('readVersion·readOpenQuestions: 한국어·영어 문서', () => {
  assert.equal(readVersion('명세 버전: v1.2\n', 'requirements'), 'v1.2');
  assert.equal(readVersion('Spec version: 2.0\n', 'requirements'), '2.0');
  assert.equal(readVersion('Design version: d1\n', 'design'), 'd1');
  assert.equal(readVersion('명세 버전:\n', 'requirements'), null);
  const text = '## 요구사항\n- Q-009: 요구사항 구간이라 무시\n## 미결 질문\n<!-- - Q-### 예시 -->\n- Q-001: a\n* Q-002 b\n## 다음\n- Q-003: 무시';
  assert.deepEqual(readOpenQuestions(text), ['Q-001', 'Q-002']);
  assert.deepEqual(readOpenQuestions('## Open questions\n- Q-010: x\n'), ['Q-010']);
});

test('install: 재설치는 막고 --upgrade 는 엔진만 바꾸며 설정·기능·고친 템플릿을 보존한다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  await p.run('init', '--set', 'AIWF_PROJECT_NAME=보존');
  p.write('features/FEAT-001/requirements.md', '내 문서');
  p.write('templates/ko/design.md', '내가 고친 템플릿');
  p.write('engine/stale.mjs', '// 이전 버전에만 있던 파일');
  assert.throws(() => install(p.projectRoot), /이미 설치/);
  const r = install(p.projectRoot, { upgrade: true });
  assert.ok(r.upgraded);
  assert.ok(!fs.existsSync(path.join(p.workflowRoot, 'engine', 'stale.mjs')));
  assert.match(fs.readFileSync(path.join(p.workflowRoot, 'project.env'), 'utf8'), /보존/);
  assert.equal(fs.readFileSync(path.join(p.workflowRoot, 'features/FEAT-001/requirements.md'), 'utf8'), '내 문서');
  assert.equal(fs.readFileSync(path.join(p.workflowRoot, 'templates/ko/design.md'), 'utf8'), '내가 고친 템플릿');
});

test('엔진·템플릿에 특정 프로젝트·개인 정보를 하드코딩하지 않는다', () => {
  const forbidden = [/koast/i, /\bdrc\b/i, /\biuu\b/i, /judahwon/i, /U04MESN8A2D/, /D0C5QHW8763/, /C:\\\\repository/i, /fishing/i];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else files.push(abs);
    }
  };
  walk(path.join(ROOT, 'engine'));
  walk(path.join(ROOT, 'templates'));
  walk(path.join(ROOT, 'skills'));
  files.push(path.join(ROOT, 'install.mjs'));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of forbidden) assert.ok(!re.test(text), `${path.relative(ROOT, file)} 에 ${re}`);
  }
});

test('install: 스킬을 .claude/skills 에 두고 훅은 기존 설정을 지키며 한 번만 등록한다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  const claudeDir = path.join(p.projectRoot, '.claude');
  for (const name of ['aiwf', 'aiwf-setup', 'aiwf-discuss', 'aiwf-design', 'aiwf-develop', 'aiwf-review', 'aiwf-verify', 'aiwf-docs']) {
    const text = fs.readFileSync(path.join(claudeDir, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\r?\nname: ${name}\r?\n`), name);
  }
  const settingsFile = path.join(claudeDir, 'settings.json');
  const countHooks = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks.PreToolUse
    .filter((e) => e.hooks.some((h) => h.command.includes(HOOK_MARKER))).length;
  assert.equal(countHooks(), 1);

  // 사용자 설정·다른 훅·다른 스킬은 유지하고, 프레임워크에서 사라진 aiwf 스킬은 지운다.
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  fs.mkdirSync(path.join(claudeDir, 'skills', 'aiwf-old'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'skills', 'my-skill'), { recursive: true });
  install(p.projectRoot, { upgrade: true });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(countHooks(), 1);
  assert.ok(!fs.existsSync(path.join(claudeDir, 'skills', 'aiwf-old')));
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'my-skill')));
  install(p.projectRoot, { upgrade: true });
  assert.equal(countHooks(), 1, '재설치해도 중복 등록하지 않는다');

  fs.writeFileSync(settingsFile, '{ 깨진 json');
  assert.equal(registerHook(p.projectRoot), 'invalid');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ 깨진 json', '해석할 수 없으면 건드리지 않는다');
});

test('install: .ai-workflow 를 제외하지 않은 린터 설정을 알린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwf-'));
  try {
    fs.writeFileSync(path.join(dir, 'eslint.config.js'), "export default [{ ignores: ['dist/'] }];\n");
    fs.writeFileSync(path.join(dir, '.prettierrc.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'biome.json'), '{"files":{"ignore":[".ai-workflow/"]}}\n');
    assert.deepEqual(install(dir, { claude: false }).linters, ['eslint', 'prettier']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install --local: .gitignore 대신 .git/info/exclude 에 한 번만 넣는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwf-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const excludeFile = path.join(dir, '.git', 'info', 'exclude');
    fs.writeFileSync(excludeFile, '# 기존\n/.ai-workflow/');
    const r = install(dir, { claude: false, local: true });
    assert.deepEqual(r.localExcludes, ['/.claude/settings.json', '/.claude/skills/aiwf*/']);
    assert.ok(!fs.existsSync(path.join(dir, '.gitignore')));
    assert.deepEqual(install(dir, { claude: false, local: true, upgrade: true }).localExcludes, []);
    assert.equal(fs.readFileSync(excludeFile, 'utf8'), '# 기존\n/.ai-workflow/\n# ai-workflow (로컬 전용)\n/.claude/settings.json\n/.claude/skills/aiwf*/\n');

    // 저장소의 하위 폴더 프로젝트는 그 폴더 기준 경로로 넣고, 실제로 git 이 무시한다.
    const sub = path.join(dir, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });
    assert.deepEqual(install(sub, { claude: false, local: true }).localExcludes, ['/apps/web/.ai-workflow/', '/apps/web/.claude/settings.json', '/apps/web/.claude/skills/aiwf*/']);
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'apps'], { cwd: dir, encoding: 'utf8' });
    assert.equal(status.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install --no-claude: .claude 를 만들지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwf-'));
  try {
    const r = install(dir, { claude: false });
    assert.equal(r.hook, 'disabled');
    assert.ok(!fs.existsSync(path.join(dir, '.claude')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
