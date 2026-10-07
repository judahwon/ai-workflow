// 테스트 공용: 임시 프로젝트(git 저장소)에 설치하고 CLI 를 메모리 출력으로 실행한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from '../install.mjs';
import { main } from '../engine/cli.mjs';

export function tempDir(prefix = 'aiwf-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 실패: ${r.stderr}`);
  return r.stdout;
}

export function setupProject({ gitRepo = true } = {}) {
  const projectRoot = tempDir();
  if (gitRepo) git(projectRoot, 'init', '-q');
  install(projectRoot);
  const workflowRoot = path.join(projectRoot, '.ai-workflow');
  let clock = Date.parse('2026-10-07T01:00:00.000Z');
  const output = [];
  const overrides = {
    projectRoot,
    workflowRoot,
    stdinIsTTY: false,
    now: () => new Date((clock += 1000)).toISOString(),
    out: (line) => output.push(line),
  };
  const run = async (...argv) => {
    output.length = 0;
    const code = await main(argv, overrides);
    return { code, out: output.join('\n') };
  };
  const featureDir = (id = 'FEAT-001') => path.join(workflowRoot, 'features', id);
  const write = (rel, content) => {
    const abs = path.join(workflowRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  return { projectRoot, workflowRoot, overrides, run, featureDir, write, cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }) };
}

export async function configuredProject() {
  const p = setupProject();
  const r = await p.run('init', '--set', 'AIWF_PROJECT_NAME=테스트 프로젝트');
  if (r.code !== 0) throw new Error(`init 실패: ${r.out}`);
  return p;
}

export const REQUIREMENTS = `# 요구사항
명세 버전: v1.0
- REQ-001: 상태 필터를 제공한다.
- REQ-002: 조회 버튼으로 적용한다.
## 미결 질문
`;

export const DESIGN = `# 설계
설계 버전: v1.0
## 미결 질문
`;

export function tasksJson(tasks) {
  return JSON.stringify({ tasks }, null, 2);
}

export const TASK = {
  id: 'TASK-001',
  title: '상태 필터',
  requirementIds: ['REQ-001', 'REQ-002'],
  goal: '목록에 상태 필터를 붙인다.',
  allowedFiles: ['src/pages/orders/**'],
  completionCriteria: ['조회 버튼으로만 적용된다.'],
};

export const APPROVE = ['--approval-text', '진행해', '--user-confirmed'];

// 모든 REQ 를 덮는 기본 기능 테스트 (설계 승인에 tests.json 이 필요하다).
export const TEST = {
  id: 'TEST-001',
  title: '단위 테스트',
  kind: 'command',
  requirementIds: ['REQ-001', 'REQ-002'],
  command: 'node -e "process.exit(0)"',
};

export function testsJson(tests = [TEST]) {
  return JSON.stringify({ tests }, null, 2);
}
