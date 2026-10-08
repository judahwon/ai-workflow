// 실행 컨텍스트. 엔진은 두 가지로 놓인다.
// - 프로젝트 설치(install.mjs): <프로젝트>/.ai-workflow/engine/. 프로젝트 루트는 엔진 위치에서 정한다.
// - 플러그인: <플러그인>/engine/. 프로젝트 루트는 현재 폴더에서 위로 .ai-workflow/ 를 찾고, 없으면 현재 폴더다.
// 절대 경로를 설정에 저장하지 않으므로 폴더를 옮기거나 다른 PC 에서 받아도 그대로 동작한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowError } from './util.mjs';
import { defaultIsPidAlive } from './lock.mjs';
import { loadConfig, defaultGit, defaultUserConfigFile } from './config.mjs';
import { runProcess } from './process.mjs';
import { requireEngineNotOlder } from './version.mjs';

export const WORKFLOW_DIR_NAME = '.ai-workflow';

export function isVendoredEngine(engineDir) {
  return path.basename(path.dirname(engineDir)) === WORKFLOW_DIR_NAME;
}

// 플러그인 모드의 프로젝트 루트: start 에서 위로 올라가며 .ai-workflow/ 가 있는 첫 폴더. 없으면 null.
// 개인 설정 폴더(~/.ai-workflow/user.env 가 있는 곳)는 프로젝트가 아니다.
export function findProjectRoot(start, env = process.env) {
  const userDirs = new Set([path.join(os.homedir(), WORKFLOW_DIR_NAME), path.dirname(defaultUserConfigFile(env))].map((d) => path.resolve(d).toLowerCase()));
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, WORKFLOW_DIR_NAME);
    if (!userDirs.has(candidate.toLowerCase()) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

// 반환: { mode, workflowRoot, projectRoot }. 플러그인 엔진이 프로젝트에 설치된 엔진과 섞이지 않게 막는다.
export function locateWorkflowRoot(engineDir, { cwd = process.cwd(), projectRoot } = {}) {
  if (isVendoredEngine(engineDir)) {
    const workflowRoot = path.dirname(engineDir);
    return { mode: 'project', workflowRoot, projectRoot: projectRoot ?? path.dirname(workflowRoot) };
  }
  const root = projectRoot ?? findProjectRoot(cwd) ?? path.resolve(cwd);
  const workflowRoot = path.join(root, WORKFLOW_DIR_NAME);
  if (fs.existsSync(path.join(workflowRoot, 'engine'))) {
    throw new WorkflowError('PROJECT_ENGINE_PRESENT', `이 프로젝트에는 엔진이 설치돼 있다 (${WORKFLOW_DIR_NAME}/engine/). 플러그인 대신 \`node ${WORKFLOW_DIR_NAME}/engine/cli.mjs\` 를 쓰거나, 플러그인으로 옮기려면 ${WORKFLOW_DIR_NAME}/engine/ 을 지운다.`, { exitCode: 3 });
  }
  return { mode: 'plugin', workflowRoot, projectRoot: root };
}

export function createContext(overrides = {}) {
  const engineDir = overrides.engineDir ?? path.dirname(fileURLToPath(import.meta.url));
  const cwd = overrides.cwd ?? process.cwd();
  const located = overrides.workflowRoot
    ? { mode: overrides.mode ?? (isVendoredEngine(engineDir) ? 'project' : 'plugin'), workflowRoot: overrides.workflowRoot, projectRoot: overrides.projectRoot ?? path.dirname(overrides.workflowRoot) }
    : locateWorkflowRoot(engineDir, { cwd, projectRoot: overrides.projectRoot });
  const { mode, workflowRoot, projectRoot } = located;
  requireEngineNotOlder(workflowRoot);
  const env = overrides.env ?? process.env;
  const ctx = {
    engineDir,
    // 기본 템플릿이 있는 곳. 프로젝트 설치면 .ai-workflow/, 플러그인이면 플러그인 루트.
    frameworkRoot: path.dirname(engineDir),
    mode,
    workflowRoot,
    projectRoot,
    cwd,
    env,
    // 이 PC 의 개인 설정 (모든 프로젝트 공통). 테스트는 임시 파일로 바꾼다.
    userConfigFile: overrides.userConfigFile ?? defaultUserConfigFile(env),
    pid: overrides.pid ?? process.pid,
    hostname: overrides.hostname ?? os.hostname(),
    platform: overrides.platform ?? process.platform,
    now: overrides.now ?? (() => new Date().toISOString()),
    isPidAlive: overrides.isPidAlive ?? defaultIsPidAlive,
    git: overrides.git ?? defaultGit,
    // 테스트·검수·알림 실행. 테스트에서 가짜로 바꿔 끼운다.
    runProcess: overrides.runProcess ?? runProcess,
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    playwright: overrides.playwright,
    out: overrides.out ?? ((line) => process.stdout.write(`${line}\n`)),
    // init 질의용. 기본은 TTY 일 때만 readline 으로 묻는다.
    prompt: overrides.prompt,
    stdinIsTTY: overrides.stdinIsTTY ?? Boolean(process.stdin.isTTY),
  };
  ctx.reloadConfig = () => {
    ctx.config = loadConfig(workflowRoot, { userFile: ctx.userConfigFile });
    return ctx.config;
  };
  ctx.reloadConfig();
  return ctx;
}

// 기능 문서 템플릿 폴더. 프로젝트가 .ai-workflow/templates/<언어>/ 에 고친 템플릿을 두면 그것을 쓴다.
export function templateDir(ctx, language) {
  const own = path.join(ctx.workflowRoot, 'templates', language);
  return fs.existsSync(own) ? own : path.join(ctx.frameworkRoot, 'templates', language);
}
