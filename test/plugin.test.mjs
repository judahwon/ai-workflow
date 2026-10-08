import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../engine/cli.mjs';
import { runHook } from '../engine/hook.mjs';
import { findProjectRoot } from '../engine/context.mjs';
import { ENGINE_VERSION, compareVersions } from '../engine/version.mjs';
import { install } from '../install.mjs';
import { tempDir, git } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 플러그인처럼 저장소의 engine/ 을 그대로 쓰고, 프로젝트는 현재 폴더(cwd)로 찾는다.
function pluginProject() {
  const projectRoot = tempDir();
  git(projectRoot, 'init', '-q');
  const output = [];
  const overrides = { cwd: projectRoot, stdinIsTTY: false, userConfigFile: path.join(tempDir('aiwf-user-'), 'user.env'), out: (line) => output.push(line) };
  const run = async (...argv) => {
    output.length = 0;
    const code = await main(argv, overrides);
    return { code, out: output.join('\n') };
  };
  const workflowRoot = path.join(projectRoot, '.ai-workflow');
  return { projectRoot, workflowRoot, run, cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }) };
}

const editInput = (filePath) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } });

test('버전: package.json·plugin.json·엔진 버전이 같다', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pkg.version, ENGINE_VERSION);
  assert.equal(plugin.version, ENGINE_VERSION);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('x', '1.0.0'), null);
});

test('플러그인: init 이 .ai-workflow/ 를 만들고, 템플릿은 플러그인 것을 쓴다', async (t) => {
  const p = pluginProject();
  t.after(p.cleanup);
  let r = await p.run('status');
  assert.match(r.out, /엔진: v[\d.]+ \(플러그인\)/);
  assert.match(r.out, /init 필요/);
  r = await p.run('init', '--set', 'AIWF_PROJECT_NAME=플러그인');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(p.workflowRoot, 'VERSION'), 'utf8').trim(), ENGINE_VERSION);
  assert.ok(fs.existsSync(path.join(p.workflowRoot, '.gitignore')));
  assert.ok(!fs.existsSync(path.join(p.workflowRoot, 'engine')));
  assert.ok(!fs.existsSync(path.join(p.workflowRoot, 'templates')));
  assert.ok(!fs.existsSync(path.join(p.projectRoot, '.claude')));
  r = await p.run('new', '--title', '필터');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(p.workflowRoot, 'features', 'FEAT-001', 'requirements.md')));
});

test('플러그인: 프로젝트가 고친 템플릿이 있으면 그것을 쓴다', async (t) => {
  const p = pluginProject();
  t.after(p.cleanup);
  await p.run('init', '--set', 'AIWF_PROJECT_NAME=p');
  const own = path.join(p.workflowRoot, 'templates', 'ko');
  fs.cpSync(path.join(ROOT, 'templates', 'ko'), own, { recursive: true });
  fs.writeFileSync(path.join(own, 'decisions.md'), '우리 팀 결정 양식 {{FEATURE_ID}}\n');
  const r = await p.run('new', '--title', '필터');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(p.workflowRoot, 'features', 'FEAT-001', 'decisions.md'), 'utf8'), '우리 팀 결정 양식 FEAT-001\n');
});

test('플러그인: 하위 폴더에서 실행해도 .ai-workflow/ 가 있는 프로젝트 루트를 찾는다', async (t) => {
  const p = pluginProject();
  t.after(p.cleanup);
  await p.run('init', '--set', 'AIWF_PROJECT_NAME=p');
  const sub = path.join(p.projectRoot, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(findProjectRoot(sub), p.projectRoot);
});

test('플러그인: init --local 은 .ai-workflow/ 만 .git/info/exclude 에 넣는다', async (t) => {
  const p = pluginProject();
  t.after(p.cleanup);
  const r = await p.run('init', '--local', '--set', 'AIWF_PROJECT_NAME=p');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /로컬 git 제외/);
  const exclude = fs.readFileSync(path.join(p.projectRoot, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/\.ai-workflow\/$/m);
  assert.equal(git(p.projectRoot, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('플러그인: 프로젝트보다 오래된 엔진은 막는다', async (t) => {
  const p = pluginProject();
  t.after(p.cleanup);
  await p.run('init', '--set', 'AIWF_PROJECT_NAME=p');
  fs.writeFileSync(path.join(p.workflowRoot, 'VERSION'), '99.0.0\n');
  const r = await p.run('status');
  assert.equal(r.code, 3);
  assert.match(r.out, /ENGINE_OUTDATED/);
});

test('플러그인: 엔진이 직접 설치된 프로젝트에서는 플러그인 엔진이 손대지 않는다', async (t) => {
  const p = pluginProject();
  t.after(p.cleanup);
  install(p.projectRoot, { claude: false });
  const r = await p.run('status');
  assert.equal(r.code, 3);
  assert.match(r.out, /PROJECT_ENGINE_PRESENT/);
  assert.equal(runHook(editInput('.ai-workflow/.env'), { projectRoot: p.projectRoot }), null);
});

test('플러그인 훅: ai-workflow 를 쓰지 않는 프로젝트는 건드리지 않고, 쓰는 프로젝트는 보호 경로를 막는다', async (t) => {
  const p = pluginProject();
  t.after(p.cleanup);
  assert.equal(runHook(editInput('.ai-workflow/.env'), { projectRoot: p.projectRoot }), null);
  await p.run('init', '--set', 'AIWF_PROJECT_NAME=p');
  const denied = runHook(editInput(path.join(p.projectRoot, '.ai-workflow', '.env')), { projectRoot: p.projectRoot });
  assert.equal(denied?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(runHook(editInput(path.join(p.projectRoot, 'src', 'a.ts')), { projectRoot: p.projectRoot }), null);
});

test('install: 프로젝트에 넣는 스킬은 플러그인 경로 대신 .ai-workflow/ 경로를 쓴다', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  install(dir);
  for (const name of fs.readdirSync(path.join(dir, '.claude', 'skills'))) {
    const text = fs.readFileSync(path.join(dir, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(!text.includes('CLAUDE_PLUGIN_ROOT'), name);
  }
  const main = fs.readFileSync(path.join(dir, '.claude', 'skills', 'aiwf', 'SKILL.md'), 'utf8');
  assert.match(main, /`node \.ai-workflow\/engine\/cli\.mjs status`/);
});

test('플러그인: 훅 설정이 엔진 훅을 가리킨다', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const [entry] = hooks.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/engine\/hook\.mjs/);
});

test('검수 브라우저: Codex 에 Playwright MCP 를 붙이는 인자', async () => {
  const { reviewBrowserArgs, parseCodexStream, buildReviewPrompt } = await import('../engine/review.mjs');
  assert.deepEqual(reviewBrowserArgs({ browser: null, outputDir: 'x', platform: 'win32' }), []);
  const out = String.raw`C:\p\.ai-workflow\runs\R001-browser`;
  const win = reviewBrowserArgs({ browser: 'chrome', outputDir: out, platform: 'win32' });
  assert.ok(win.includes("mcp_servers.aiwf_browser.command='cmd'"));
  const args = win.find((a) => a.startsWith('mcp_servers.aiwf_browser.args='));
  assert.match(args, /^mcp_servers\.aiwf_browser\.args=\['\/d','\/c','npx','-y','@playwright\/mcp@[\d.]+','--browser','chrome','--headless','--isolated','--output-dir','(.+)'\]$/);
  assert.equal(/'--output-dir','(.+)'\]$/.exec(args)[1], out);
  assert.ok(!win.some((a) => a.includes('"')), 'cmd.exe 를 거쳐도 깨지지 않게 큰따옴표를 쓰지 않는다');
  assert.ok(win.includes("mcp_servers.aiwf_browser.default_tools_approval_mode='approve'"));
  const posix = reviewBrowserArgs({ browser: 'msedge', outputDir: '/p/out', platform: 'linux' });
  assert.ok(posix.includes("mcp_servers.aiwf_browser.command='npx'"));
  assert.throws(() => reviewBrowserArgs({ browser: 'chrome', outputDir: "/it's", platform: 'linux' }), /REVIEW_BROWSER_PATH|'/);
  const stream = [
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'aiwf_browser', tool: 'browser_navigate' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'other', tool: 'x' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
  ].map((e) => JSON.stringify(e)).join('\n');
  assert.equal(parseCodexStream(stream).browserCalls, 1);
  assert.equal(typeof buildReviewPrompt, 'function');
});
