// 작업 계약 검증. 개발은 도구를 쓰는 세션이 하므로 allowedFiles 는 수정 허용 범위(경로·glob)다.
import { blocked, isValidId } from './util.mjs';

const TASK_KEYS = new Set(['id', 'title', 'requirementIds', 'goal', 'allowedFiles', 'completionCriteria', 'dependsOn', 'stopConditions']);
const ALWAYS_DENIED = ['.git', '.ai-workflow', 'node_modules'];
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const BAD_CHARS = /[\u0000-\u001f<>:"|\\]/;

export const MAX_TASKS = 50;
export const MAX_PATTERNS_PER_TASK = 50;

function isStringArray(v, { nonEmpty = true, max = 100 } = {}) {
  return Array.isArray(v) && (!nonEmpty || v.length > 0) && v.length <= max
    && v.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 2000);
}

// 프로젝트 루트 기준 '/' 구분 상대 경로 또는 glob(*, **, ?). 반환: 오류 문자열 또는 null.
export function checkAllowedPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 240) return '빈 값이거나 너무 길다';
  if (pattern !== pattern.trim()) return '앞뒤 공백';
  if (BAD_CHARS.test(pattern)) return "허용되지 않은 문자 (구분자는 '/')";
  if (pattern.startsWith('/') || /^[a-zA-Z]:/.test(pattern)) return '절대 경로';
  const segments = pattern.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return '빈 구간·. ·.. 금지';
    if (RESERVED.test(seg)) return '예약된 이름';
    if (seg.includes('**') && seg !== '**') return "'**' 는 구간 전체로만 쓴다";
  }
  if (segments.every((seg) => seg === '**' || seg === '*')) return '프로젝트 전체를 허용하는 패턴은 쓸 수 없다';
  const first = segments[0].toLowerCase();
  if (ALWAYS_DENIED.includes(first)) return `${segments[0]}/ 는 수정 범위가 될 수 없다`;
  const last = segments[segments.length - 1].toLowerCase();
  if (last.startsWith('.env')) return '.env 파일은 수정 범위가 될 수 없다';
  return null;
}

// dependsOn 위상 정렬. 독립 작업은 목록 순서를 유지한다. 미지·순환 의존은 차단.
export function orderTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const d of t.dependsOn ?? []) {
      if (!byId.has(d)) throw blocked('TASK_INVALID', `${t.id} 의 의존 작업 ${d} 가 목록에 없다.`);
    }
  }
  const ordered = [];
  const state = new Map();
  const visit = (t, trail) => {
    if (state.get(t.id) === 'done') return;
    if (state.get(t.id) === 'visiting') throw blocked('TASK_INVALID', `순환 의존: ${[...trail, t.id].join(' → ')}`);
    state.set(t.id, 'visiting');
    for (const d of t.dependsOn ?? []) visit(byId.get(d), [...trail, t.id]);
    state.set(t.id, 'done');
    ordered.push(t.id);
  };
  for (const t of tasks) visit(t, []);
  return ordered;
}

export function validateTaskContract(task, { knownRequirementIds }) {
  const errors = [];
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw blocked('TASK_INVALID', '작업은 JSON 객체여야 한다.');
  for (const k of Object.keys(task)) if (!TASK_KEYS.has(k)) errors.push(`허용되지 않은 필드 ${k}`);
  if (!isValidId('task', task.id)) errors.push('id 는 TASK-### 형식');
  if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 200) errors.push('title 필수 (200자 이하)');
  if (!isStringArray(task.requirementIds) || !task.requirementIds.every((r) => isValidId('requirement', r))) {
    errors.push('requirementIds 는 REQ-### 배열');
  } else if (new Set(task.requirementIds).size !== task.requirementIds.length) {
    errors.push('requirementIds 중복');
  } else if (knownRequirementIds) {
    const unknown = task.requirementIds.filter((r) => !knownRequirementIds.includes(r));
    if (unknown.length) errors.push(`승인된 요구사항에 없는 ID: ${unknown.join(',')}`);
  }
  if (typeof task.goal !== 'string' || !task.goal.trim() || task.goal.length > 4000) errors.push('goal 필수');
  if (!isStringArray(task.allowedFiles, { max: MAX_PATTERNS_PER_TASK })) {
    errors.push(`allowedFiles 는 1~${MAX_PATTERNS_PER_TASK}개 경로·glob 배열`);
  } else {
    for (const p of task.allowedFiles) {
      const problem = checkAllowedPattern(p);
      if (problem) errors.push(`allowedFiles ${JSON.stringify(p.slice(0, 80))}: ${problem}`);
    }
    if (new Set(task.allowedFiles.map((p) => p.toLowerCase())).size !== task.allowedFiles.length) errors.push('allowedFiles 중복');
  }
  if (!isStringArray(task.completionCriteria)) errors.push('completionCriteria 는 비어 있지 않은 문자열 배열');
  if (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || !task.dependsOn.every((d) => isValidId('task', d) && d !== task.id))) {
    errors.push('dependsOn 은 다른 TASK ID 배열');
  }
  if (task.stopConditions !== undefined && !isStringArray(task.stopConditions, { nonEmpty: false })) errors.push('stopConditions 는 문자열 배열');
  if (errors.length) throw blocked('TASK_INVALID', `${task.id ?? '(id 없음)'} 작업 계약 오류: ${errors.join('; ')}`);
  return task;
}

// 작업 목록 전체 검증: 형식, ID 중복, 의존 관계, 모든 요구사항이 작업에 연결되는지.
export function validateTaskList(data, { requirementIds }) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : null;
  if (!tasks || tasks.length === 0) throw blocked('TASKS_EMPTY', 'tasks.json 은 {"tasks":[...]} 형식이고 작업이 1개 이상이어야 한다.');
  if (tasks.length > MAX_TASKS) throw blocked('TASKS_TOO_MANY', `작업은 ${MAX_TASKS}개 이하로 나눈다.`);
  const ids = new Set();
  for (const t of tasks) {
    validateTaskContract(t, { knownRequirementIds: requirementIds });
    if (ids.has(t.id)) throw blocked('TASK_INVALID', `중복 작업 ID ${t.id}`);
    ids.add(t.id);
  }
  const order = orderTasks(tasks);
  const covered = new Set(tasks.flatMap((t) => t.requirementIds));
  const uncovered = requirementIds.filter((r) => !covered.has(r));
  if (uncovered.length) throw blocked('REQUIREMENTS_UNCOVERED', `작업에 연결되지 않은 요구사항: ${uncovered.join(', ')}`);
  return { tasks, order };
}
