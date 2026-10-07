// 엔진 버전. package.json·.claude-plugin/plugin.json 의 version 과 같아야 한다 (테스트가 확인한다).
// 프로젝트의 .ai-workflow/VERSION 은 그 프로젝트를 마지막으로 다룬 엔진 버전이다.
// 플러그인은 사람마다 버전이 다를 수 있으므로, 프로젝트보다 오래된 엔진은 작업을 막는다.
import fs from 'node:fs';
import path from 'node:path';
import { WorkflowError, atomicWriteFile } from './util.mjs';

export const ENGINE_VERSION = '0.3.0';
export const VERSION_FILE = 'VERSION';

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

// a < b 이면 음수, 같으면 0, a > b 이면 양수. 형식이 틀리면 null.
export function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function readProjectVersion(workflowRoot) {
  const file = path.join(workflowRoot, VERSION_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
}

export function requireEngineNotOlder(workflowRoot) {
  const project = readProjectVersion(workflowRoot);
  if (project && compareVersions(project, ENGINE_VERSION) > 0) {
    throw new WorkflowError('ENGINE_OUTDATED', `이 프로젝트는 ai-workflow v${project} 로 기록됐는데 엔진은 v${ENGINE_VERSION} 이다. 플러그인을 업데이트한다 (/plugin 에서 ai-workflow 업데이트).`, { exitCode: 3 });
  }
}

// 프로젝트 버전을 이 엔진 버전으로 올린다. 낮추지는 않는다. 반환: 바꿨으면 true.
export function stampProjectVersion(workflowRoot) {
  const project = readProjectVersion(workflowRoot);
  if (project && compareVersions(project, ENGINE_VERSION) >= 0) return false;
  atomicWriteFile(path.join(workflowRoot, VERSION_FILE), `${ENGINE_VERSION}\n`);
  return true;
}
