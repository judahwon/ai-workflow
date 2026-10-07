#!/usr/bin/env node
// 프로젝트에 ai-workflow 를 설치한다: <프로젝트>/.ai-workflow/{engine,templates} 복사, .gitignore·.env.example 생성.
// 사용: node install.mjs <프로젝트 루트> [--upgrade]
//   --upgrade : 이미 설치된 프로젝트의 엔진만 교체한다. features/·runs/·.env·직접 고친 템플릿은 건드리지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureGitignore, writeEnvExample } from './engine/init.mjs';

const FRAMEWORK_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = '.ai-workflow';

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

export function install(projectRoot, { upgrade = false } = {}) {
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
  const pkg = JSON.parse(fs.readFileSync(path.join(FRAMEWORK_ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(workflowRoot, 'VERSION'), `${pkg.version}\n`);
  const ignoreAdded = ensureGitignore(workflowRoot);
  writeEnvExample(workflowRoot);
  return { workflowRoot, upgraded: installed, engineFiles: engine.length, templateFiles: templates.length, ignoreAdded, version: pkg.version };
}

function main(argv) {
  const args = argv.filter((a) => a !== '--upgrade');
  if (args.length !== 1 || args[0].startsWith('--')) {
    process.stderr.write('사용: node install.mjs <프로젝트 루트> [--upgrade]\n');
    return 2;
  }
  try {
    const r = install(args[0], { upgrade: argv.includes('--upgrade') });
    process.stdout.write([
      `${r.upgraded ? '엔진 교체' : '설치'} 완료 (v${r.version}): ${r.workflowRoot}`,
      `  엔진 파일 ${r.engineFiles}개, 새 템플릿 ${r.templateFiles}개${r.ignoreAdded.length ? `, .gitignore 추가: ${r.ignoreAdded.join(' ')}` : ''}`,
      '',
      '다음 단계 (프로젝트 루트에서):',
      '  node .ai-workflow/engine/cli.mjs init      # 프로젝트·개인 설정 질의 → .ai-workflow/.env',
      '  node .ai-workflow/engine/cli.mjs status',
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
