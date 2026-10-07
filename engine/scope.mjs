// 작업 수정 범위: allowedFiles 패턴 매칭, 항상 보호하는 경로, git 기준 변경 파일 계산.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './util.mjs';

// 빈 트리. 커밋이 하나도 없는 저장소의 비교 기준.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// '/' 구분 glob 을 정규식으로 바꾼다. '**' 는 0개 이상 구간, '*'·'?' 는 한 구간 안에서만 맞는다.
// glob 문자가 없는 패턴은 그 파일 자체 또는 그 폴더 아래 전체를 뜻한다.
export function patternToRegExp(pattern, { ignoreCase = false } = {}) {
  const segments = pattern.split('/');
  const hasGlob = /[*?]/.test(pattern);
  let source = '';
  segments.forEach((seg, index) => {
    const last = index === segments.length - 1;
    if (seg === '**') {
      source += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    source += escapeRegExp(seg).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (!last) source += '/';
  });
  if (!hasGlob) source += '(?:/.*)?';
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
}

export function matchesAllowed(relPath, patterns, options) {
  return patterns.some((p) => patternToRegExp(p, options).test(relPath));
}

// 절대·상대 경로를 프로젝트 루트 기준 '/' 경로로 바꾼다. 루트 밖이면 null.
export function toProjectRelative(projectRoot, filePath) {
  const abs = path.resolve(projectRoot, filePath);
  const rel = path.relative(projectRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// 작업 여부와 관계없이 세션이 고치면 안 되는 경로. 반환: 이유 문자열 또는 null.
export function protectedReason(relPath, { ignoreCase = false } = {}) {
  const p = ignoreCase ? relPath.toLowerCase() : relPath;
  if (p === '.git' || p.startsWith('.git/')) return 'git 내부 파일';
  if (p.startsWith('.ai-workflow/engine/')) return '워크플로 엔진 (설치·업그레이드로만 바뀐다)';
  if (p.startsWith('.ai-workflow/runs/') || p.startsWith('.ai-workflow/state/')) return '워크플로 실행 상태 (엔진 명령으로만 바뀐다)';
  if (p === '.ai-workflow/.env') return '워크플로 설정 (init 으로만 바꾼다)';
  if (p === '.ai-workflow/checks.json') return '프로젝트 검사 설정 (사용자 승인과 함께 checks-set 으로만 바꾼다)';
  return null;
}

// 작업 중 범위와 관계없이 고칠 수 있는 경로: 해당 기능 문서. 문서가 바뀌면 승인 무효화로 이어진다.
export function featureDocPrefix(featureId) {
  return `.ai-workflow/features/${featureId}/`;
}

// ---------- git 기준 변경 파일 ----------

function splitZ(text) {
  return text.split('\0').filter(Boolean);
}

function fileHash(projectRoot, relPath) {
  const abs = path.join(projectRoot, relPath);
  try {
    return fs.statSync(abs).isFile() ? sha256(fs.readFileSync(abs)) : 'NOT_A_FILE';
  } catch {
    return 'MISSING';
  }
}

export function gitAvailable(ctx) {
  const r = ctx.git(ctx.projectRoot, ['rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

// 기준 커밋 대비 바뀐 파일 + 추적되지 않은 파일 (프로젝트 루트 기준 상대 경로).
function changedSince(ctx, base) {
  const diff = ctx.git(ctx.projectRoot, ['diff', '--name-only', '--no-renames', '--relative', '-z', base, '--']);
  if (diff.status !== 0) throw new Error(`git diff 실패: ${diff.stderr.trim()}`);
  const untracked = ctx.git(ctx.projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.status !== 0) throw new Error(`git ls-files 실패: ${untracked.stderr.trim()}`);
  return [...new Set([...splitZ(diff.stdout), ...splitZ(untracked.stdout)])].sort();
}

// 작업 시작 시점 기록: 기준 커밋과, 그때 이미 바뀌어 있던 파일의 내용 해시.
export function captureBaseline(ctx) {
  if (!gitAvailable(ctx)) return null;
  const head = ctx.git(ctx.projectRoot, ['rev-parse', '--verify', '-q', 'HEAD']);
  const base = head.status === 0 ? head.stdout.trim() : EMPTY_TREE;
  const dirty = Object.fromEntries(changedSince(ctx, base).map((rel) => [rel, fileHash(ctx.projectRoot, rel)]));
  return { base, dirty };
}

// 설치기(install --upgrade)가 교체하는 파일. 작업 도중 엔진을 올려도 작업의 변경으로 세지 않는다.
const INSTALLER_OWNED = ['.ai-workflow/engine/', '.ai-workflow/templates/', '.ai-workflow/VERSION', '.ai-workflow/.env.example', '.claude/skills/aiwf'];

export function isInstallerOwned(rel) {
  return INSTALLER_OWNED.some((prefix) => rel.startsWith(prefix));
}

// 작업 시작 이후 이 작업이 바꾼 파일. 시작 전부터 바뀌어 있던 파일은 내용이 또 바뀐 경우만 센다.
export function changedSinceBaseline(ctx, baseline) {
  const now = changedSince(ctx, baseline.base).filter((rel) => !isInstallerOwned(rel));
  const result = new Set();
  for (const rel of now) {
    if (!(rel in baseline.dirty) || baseline.dirty[rel] !== fileHash(ctx.projectRoot, rel)) result.add(rel);
  }
  // 시작 전에 바뀌어 있었는데 지금은 원래대로 돌아간 파일도 이 작업이 건드린 것이다.
  for (const rel of Object.keys(baseline.dirty)) if (!now.includes(rel) && !isInstallerOwned(rel)) result.add(rel);
  return [...result].sort();
}

// 바뀐 파일을 범위 안/밖으로 나눈다. 해당 기능 문서와 git 제외 상태 폴더는 범위 판단에서 뺀다.
export function classifyChanges(files, { allowedFiles, featureId, ignoreCase }) {
  const docPrefix = featureDocPrefix(featureId);
  const inScope = [];
  const outOfScope = [];
  const docs = [];
  for (const rel of files) {
    const key = ignoreCase ? rel.toLowerCase() : rel;
    if (key.startsWith(ignoreCase ? docPrefix.toLowerCase() : docPrefix)) docs.push(rel);
    else if (!protectedReason(rel, { ignoreCase }) && matchesAllowed(rel, allowedFiles, { ignoreCase })) inScope.push(rel);
    else outOfScope.push(rel);
  }
  return { inScope, outOfScope, docs };
}

// 작업 트리 상태의 지문. 검수·검증 결과가 지금 코드에 대한 것인지 확인하는 데 쓴다.
// 세션 설정(.claude/)과 기능 문서(승인 무효화로 따로 관리)는 뺀다. git 저장소가 아니면 null.
const FINGERPRINT_EXCLUDED = ['.claude/', '.ai-workflow/features/'];

export function workspaceFingerprint(ctx) {
  if (!gitAvailable(ctx)) return null;
  const head = ctx.git(ctx.projectRoot, ['rev-parse', '--verify', '-q', 'HEAD']);
  const base = head.status === 0 ? head.stdout.trim() : EMPTY_TREE;
  const files = changedSince(ctx, base)
    .filter((rel) => !FINGERPRINT_EXCLUDED.some((prefix) => rel.startsWith(prefix)))
    .map((rel) => [rel, fileHash(ctx.projectRoot, rel)]);
  return sha256(JSON.stringify({ base, files }));
}

// 기준 커밋 대비 diff 텍스트 (검수 요청용). 추적되지 않은 파일은 내용 그대로 붙인다.
export function diffSince(ctx, base, files, { maxBytes = 200 * 1024 } = {}) {
  const parts = [];
  const tracked = ctx.git(ctx.projectRoot, ['diff', '--no-color', '--relative', base, '--', ...files]);
  if (tracked.status === 0 && tracked.stdout) parts.push(tracked.stdout);
  const untracked = ctx.git(ctx.projectRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files]);
  for (const rel of untracked.status === 0 ? splitZ(untracked.stdout) : []) {
    try {
      parts.push(`--- /dev/null\n+++ b/${rel} (새 파일)\n${fs.readFileSync(path.join(ctx.projectRoot, rel), 'utf8')}`);
    } catch { /* 읽을 수 없는 파일은 건너뛴다 */ }
  }
  const text = parts.join('\n');
  return Buffer.byteLength(text) > maxBytes ? `${text.slice(0, maxBytes)}\n…[diff 가 상한(${maxBytes} bytes)을 넘어 잘림. 나머지는 파일을 직접 읽는다]` : text;
}
