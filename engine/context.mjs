// 실행 컨텍스트. 엔진은 <프로젝트>/.ai-workflow/engine/ 에 설치되고, 프로젝트 루트는 그 위치에서 정한다.
// 절대 경로를 설정에 저장하지 않으므로 폴더를 옮기거나 다른 PC 에서 받아도 그대로 동작한다.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowError } from './util.mjs';
import { defaultIsPidAlive } from './lock.mjs';
import { loadConfig, defaultGit } from './config.mjs';
import { runProcess } from './process.mjs';

export const WORKFLOW_DIR_NAME = '.ai-workflow';

export function locateWorkflowRoot(engineDir) {
  const workflowRoot = path.dirname(engineDir);
  if (path.basename(workflowRoot) !== WORKFLOW_DIR_NAME) {
    throw new WorkflowError('NOT_INSTALLED', `엔진이 ${WORKFLOW_DIR_NAME}/engine/ 아래에 있지 않다. 프레임워크 저장소의 install.mjs 로 프로젝트에 설치한다.`);
  }
  return workflowRoot;
}

export function createContext(overrides = {}) {
  const engineDir = overrides.engineDir ?? path.dirname(fileURLToPath(import.meta.url));
  const workflowRoot = overrides.workflowRoot ?? locateWorkflowRoot(engineDir);
  const projectRoot = overrides.projectRoot ?? path.dirname(workflowRoot);
  const ctx = {
    engineDir,
    workflowRoot,
    projectRoot,
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
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
    ctx.config = loadConfig(workflowRoot);
    return ctx.config;
  };
  ctx.reloadConfig();
  return ctx;
}
