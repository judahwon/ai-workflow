// 테스트 정의 검증.
// - 프로젝트 검사(.ai-workflow/checks.json): 린트·빌드·단위 테스트처럼 매번 돌리는 명령과 서버 주소(origins). 사용자 승인으로만 바꾼다.
// - 기능 테스트(features/FEAT-###/tests.json): 요구사항(REQ)을 확인하는 command·http·browser·manual 테스트. 설계 승인에 포함된다.
import fs from 'node:fs';
import path from 'node:path';
import { blocked, isValidId, hashJson, readJson, redact } from './util.mjs';
import { looksLikeSecret } from './config.mjs';

export const CHECKS_FILE = 'checks.json';
export const TEST_KINDS = ['command', 'http', 'browser', 'manual'];
export const TEST_ENV_PREFIX = 'AIWF_TEST_';
export const MAX_TESTS = 100;
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const CHECK_ID = /^[a-z][a-z0-9-]{0,30}$/;
const ORIGIN_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ENV_NAME = new RegExp(`^${TEST_ENV_PREFIX}[A-Z0-9_]{1,60}$`);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isText = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !CONTROL.test(v);

function checkKeys(obj, allowed, e, where = '') {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) e(`${where}허용되지 않은 필드 ${k}`);
}

// 프로젝트 루트 기준 상대 폴더 ('.' 허용). 반환: 오류 문자열 또는 null.
export function checkCwd(cwd) {
  if (cwd === undefined || cwd === '.') return null;
  if (!isText(cwd, 240) || cwd.startsWith('/') || /^[a-zA-Z]:/.test(cwd) || cwd.includes('\\')) return 'cwd 는 프로젝트 루트 기준 상대 경로 (구분자 /)';
  if (cwd.split('/').some((seg) => seg === '' || seg === '..' || seg === '.')) return 'cwd 에 빈 구간·. ·.. 금지';
  return null;
}

export function checkUrlPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1000) return '경로는 1~1000자';
  if (!p.startsWith('/') || p.startsWith('//') || /[\s\\]/.test(p) || CONTROL.test(p)) return '경로는 "/" 로 시작하는 상대 경로 (공백·역슬래시·"//" 불가)';
  return null;
}

function checkOrigin(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return 'http(s) 만 허용';
    if (u.origin !== value) return 'scheme://host[:port] 형식 (경로·끝 / 없이)';
    return null;
  } catch {
    return 'URL 형식 오류';
  }
}

function validateCommand(item, e) {
  if (!isText(item.command, 1000)) e('command 는 1~1000자 문자열');
  else if (looksLikeSecret(item.command)) e('command 에 토큰·비밀번호 형태 값을 넣지 않는다');
  const cwdError = checkCwd(item.cwd);
  if (cwdError) e(cwdError);
}

// ---------- 프로젝트 검사 ----------

export function checksPath(ctx) {
  return path.join(ctx.workflowRoot, CHECKS_FILE);
}

export function checksContentHash(data) {
  return hashJson({ origins: data.origins ?? {}, checks: data.checks ?? [] });
}

export function validateChecks(data) {
  const errors = [];
  const e = (m) => errors.push(m);
  if (!isObj(data)) throw blocked('CHECKS_INVALID', 'checks.json 은 JSON 객체여야 한다.');
  checkKeys(data, ['schemaVersion', 'origins', 'checks', 'approval'], e);
  const origins = data.origins ?? {};
  if (!isObj(origins)) e('origins 는 { 이름: "http://host:port" } 객체');
  else {
    for (const [name, value] of Object.entries(origins)) {
      if (!ORIGIN_NAME.test(name)) e(`origins.${name}: 이름은 영소문자·숫자·-`);
      const problem = typeof value === 'string' ? checkOrigin(value) : '문자열이어야 한다';
      if (problem) e(`origins.${name}: ${problem}`);
    }
  }
  const checks = data.checks ?? [];
  if (!Array.isArray(checks) || checks.length > 30) e('checks 는 30개 이하 배열');
  else {
    const ids = new Set();
    checks.forEach((c, i) => {
      const where = isObj(c) && typeof c.id === 'string' ? c.id.slice(0, 30) : `checks[${i}]`;
      const ce = (m) => e(`${where}: ${m}`);
      if (!isObj(c)) return ce('객체가 아니다');
      checkKeys(c, ['id', 'title', 'command', 'cwd', 'timeoutSec', 'required'], ce);
      if (!CHECK_ID.test(String(c.id))) ce('id 는 영소문자로 시작하는 영소문자·숫자·- (31자 이하)');
      else if (ids.has(c.id)) ce('중복 id');
      ids.add(c.id);
      if (!isText(c.title, 200)) ce('title 필수');
      validateCommand(c, ce);
      if (c.timeoutSec !== undefined && !isInt(c.timeoutSec, 1, 7200)) ce('timeoutSec 는 1~7200');
      if (c.required !== undefined && typeof c.required !== 'boolean') ce('required 는 true/false');
    });
  }
  if (errors.length) throw blocked('CHECKS_INVALID', `checks.json 오류: ${errors.slice(0, 20).join('; ')}`);
  return { origins: { ...origins }, checks: checks.map((c) => ({ timeoutSec: 900, required: true, cwd: '.', ...c })) };
}

// 반환: { exists, approved, origins, checks, approval, error }
export function loadChecks(ctx) {
  const file = checksPath(ctx);
  if (!fs.existsSync(file)) return { exists: false, approved: false, origins: {}, checks: [], approval: null, error: null };
  try {
    const raw = readJson(file);
    const valid = validateChecks(raw);
    const approved = !!raw.approval && raw.approval.hash === checksContentHash(valid);
    return { exists: true, approved, ...valid, approval: raw.approval ?? null, error: null };
  } catch (e) {
    return { exists: true, approved: false, origins: {}, checks: [], approval: null, error: e.message };
  }
}

// ---------- 기능 테스트 ----------

const STEP_SPEC = {
  goto: { req: ['path'], opt: [] },
  fill: { req: ['selector'], opt: ['value', 'valueFromEnv'] },
  click: { req: ['selector'], opt: [] },
  press: { req: ['selector', 'key'], opt: [] },
  selectOption: { req: ['selector', 'value'], opt: [] },
  check: { req: ['selector'], opt: [] },
  expectVisible: { req: ['selector'], opt: [] },
  expectHidden: { req: ['selector'], opt: [] },
  expectText: { req: ['selector', 'text'], opt: ['exact'] },
  expectURL: { req: ['path'], opt: [] },
  expectCount: { req: ['selector', 'count'], opt: [] },
};
export const ASSERTIONS = ['expectVisible', 'expectHidden', 'expectText', 'expectURL', 'expectCount'];

function validateEnvValue(v, e, where) {
  if (isObj(v)) {
    if (Object.keys(v).length !== 1 || !ENV_NAME.test(String(v.fromEnv))) e(`${where} 는 문자열 또는 { "fromEnv": "${TEST_ENV_PREFIX}..." }`);
  } else if (typeof v !== 'string' || v.length > 2000) e(`${where} 는 2000자 이하 문자열`);
  else if (looksLikeSecret(v) || redact(v) !== v) e(`${where} 에 비밀값을 직접 쓰지 않는다. { "fromEnv": "${TEST_ENV_PREFIX}..." } 를 쓴다`);
}

function validateResponseExpect(x, e) {
  if (!isObj(x)) return e('expect 객체 필요');
  checkKeys(x, ['status', 'contentType', 'bodyContains', 'json'], e, 'expect.');
  if (!isInt(x.status, 100, 599)) e('expect.status (100~599) 필수');
  if (x.contentType !== undefined && !isText(x.contentType, 100)) e('expect.contentType 형식 오류');
  if (x.bodyContains !== undefined && (!Array.isArray(x.bodyContains) || !x.bodyContains.every((s) => isText(s, 500)))) e('expect.bodyContains 는 문자열 배열');
  if (x.json !== undefined) {
    if (!Array.isArray(x.json) || x.json.length === 0 || x.json.length > 50) return e('expect.json 은 1~50개 배열');
    x.json.forEach((j, i) => {
      if (!isObj(j) || typeof j.path !== 'string' || !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(j.path)) return e(`expect.json[${i}].path 는 a.b.0 형식`);
      const keys = Object.keys(j).filter((k) => k !== 'path');
      if (keys.length !== 1 || !['equals', 'exists'].includes(keys[0])) return e(`expect.json[${i}] 은 equals 또는 exists 하나`);
      if (keys[0] === 'exists' && typeof j.exists !== 'boolean') e(`expect.json[${i}].exists 는 boolean`);
      if (keys[0] === 'equals' && !(j.equals === null || ['string', 'number', 'boolean'].includes(typeof j.equals))) e(`expect.json[${i}].equals 는 원시값`);
    });
  }
}

function validateHttp(t, origins, e) {
  const r = t.request;
  if (!isObj(r)) return e('request 객체 필요');
  checkKeys(r, ['origin', 'method', 'path', 'headers', 'body'], e, 'request.');
  if (!(r.origin in origins)) e(`request.origin 은 checks.json origins 의 이름 (${Object.keys(origins).join(', ') || '없음'})`);
  if (r.method !== undefined && !HTTP_METHODS.includes(r.method)) e(`request.method 는 ${HTTP_METHODS.join('|')}`);
  const pathError = checkUrlPath(r.path);
  if (pathError) e(`request.path: ${pathError}`);
  if (r.headers !== undefined) {
    if (!isObj(r.headers) || Object.keys(r.headers).length > 30) e('request.headers 는 30개 이하 객체');
    else for (const [k, v] of Object.entries(r.headers)) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(k)) e(`request.headers.${k.slice(0, 40)}: 헤더 이름 형식 오류`);
      validateEnvValue(v, e, `request.headers.${k}`);
    }
  }
  if (r.body !== undefined && JSON.stringify(r.body).length > 65536) e('request.body 64KB 상한');
  validateResponseExpect(t.expect, e);
}

function validateBrowser(t, origins, e) {
  if (!(t.origin in origins)) e(`origin 은 checks.json origins 의 이름 (${Object.keys(origins).join(', ') || '없음'})`);
  if (t.viewport !== undefined && (!isObj(t.viewport) || !isInt(t.viewport.width, 320, 3840) || !isInt(t.viewport.height, 240, 2160) || Object.keys(t.viewport).length !== 2)) {
    e('viewport 는 {width,height}');
  }
  const steps = t.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 80) return e('steps 는 1~80개 배열');
  if (steps[0]?.action !== 'goto') e('첫 단계는 goto');
  if (!steps.some((s) => ASSERTIONS.includes(s?.action))) e(`검증 단계(${ASSERTIONS.join('/')})가 1개 이상 필요`);
  steps.forEach((s, i) => {
    const se = (m) => e(`steps[${i}]: ${m}`);
    if (!isObj(s)) return se('객체가 아니다');
    const spec = STEP_SPEC[s.action];
    if (!spec) return se(`지원하지 않는 action ${JSON.stringify(String(s.action).slice(0, 30))} (${Object.keys(STEP_SPEC).join(', ')})`);
    checkKeys(s, ['action', 'note', ...spec.req, ...spec.opt], se);
    for (const k of spec.req) if (s[k] === undefined) se(`${k} 필요`);
    if ('selector' in s && !isText(s.selector, 300)) se('selector 는 1~300자');
    if ((s.action === 'goto' || s.action === 'expectURL') && checkUrlPath(s.path)) se(checkUrlPath(s.path));
    if (s.action === 'fill') {
      if ((s.value === undefined) === (s.valueFromEnv === undefined)) se('value 또는 valueFromEnv 중 하나');
      if (s.value !== undefined) validateEnvValue(s.value, se, 'value');
      if (s.valueFromEnv !== undefined && !ENV_NAME.test(String(s.valueFromEnv))) se(`valueFromEnv 는 ${TEST_ENV_PREFIX} 로 시작하는 환경변수 이름`);
    }
    if (s.action === 'press' && (typeof s.key !== 'string' || !/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/.test(s.key))) se('key 형식 오류 (예: Enter, Control+A)');
    if (s.action === 'selectOption' && !isText(s.value, 200)) se('value 는 200자 이하');
    if (s.action === 'expectText' && !isText(s.text, 1000)) se('text 는 1~1000자');
    if (s.action === 'expectText' && s.exact !== undefined && typeof s.exact !== 'boolean') se('exact 는 boolean');
    if (s.action === 'expectCount' && !isInt(s.count, 0, 10000)) se('count 는 0~10000');
  });
}

const COMMON_KEYS = ['id', 'title', 'kind', 'requirementIds', 'required', 'timeoutSec', 'notes'];
const KIND_KEYS = {
  command: ['command', 'cwd'],
  http: ['request', 'expect'],
  browser: ['origin', 'viewport', 'steps'],
  manual: ['steps', 'expected'],
};

// 반환: { tests, coverage }. requirementIds 는 기획 승인된 REQ.
export function validateTests(data, { requirementIds, origins }) {
  const errors = [];
  const tests = Array.isArray(data?.tests) ? data.tests : null;
  if (!tests || tests.length === 0) throw blocked('TESTS_EMPTY', 'tests.json 은 {"tests":[...]} 형식이고 테스트가 1개 이상이어야 한다.');
  if (tests.length > MAX_TESTS) throw blocked('TESTS_INVALID', `테스트는 ${MAX_TESTS}개 이하.`);
  const ids = new Set();
  tests.forEach((t, i) => {
    const where = isObj(t) && typeof t.id === 'string' ? t.id.slice(0, 20) : `tests[${i}]`;
    const e = (m) => errors.push(`${where}: ${m}`);
    if (!isObj(t)) return e('객체가 아니다');
    if (!TEST_KINDS.includes(t.kind)) return e(`kind 는 ${TEST_KINDS.join('|')}`);
    checkKeys(t, [...COMMON_KEYS, ...KIND_KEYS[t.kind]], e);
    if (!isValidId('test', t.id)) e('id 는 TEST-###');
    else if (ids.has(t.id)) e('중복 id');
    ids.add(t.id);
    if (!isText(t.title, 200)) e('title 필수 (200자 이하)');
    if (!Array.isArray(t.requirementIds) || !t.requirementIds.every((r) => isValidId('requirement', r)) || new Set(t.requirementIds).size !== t.requirementIds.length) {
      e('requirementIds 는 REQ-### 배열 (중복 불가, 빈 배열 가능)');
    } else {
      const unknown = t.requirementIds.filter((r) => !requirementIds.includes(r));
      if (unknown.length) e(`승인된 요구사항에 없는 ID: ${unknown.join(',')}`);
    }
    if (t.required !== undefined && typeof t.required !== 'boolean') e('required 는 true/false');
    if (t.timeoutSec !== undefined && !isInt(t.timeoutSec, 1, 7200)) e('timeoutSec 는 1~7200');
    if (t.notes !== undefined && !isText(t.notes, 2000)) e('notes 는 2000자 이하');
    if (t.kind === 'command') validateCommand(t, e);
    if (t.kind === 'http') validateHttp(t, origins, e);
    if (t.kind === 'browser') validateBrowser(t, origins, e);
    if (t.kind === 'manual') {
      if (!Array.isArray(t.steps) || t.steps.length === 0 || !t.steps.every((s) => isText(s, 1000))) e('steps 는 사람이 따라 할 절차 문자열 배열');
      if (!isText(t.expected, 2000)) e('expected 는 기대 결과 문장');
    }
  });
  if (errors.length) throw blocked('TESTS_INVALID', `tests.json 오류: ${errors.slice(0, 20).join('; ')}${errors.length > 20 ? ` 외 ${errors.length - 20}건` : ''}`);
  const coverage = Object.fromEntries(requirementIds.map((r) => [r, tests.filter((t) => t.required !== false && t.requirementIds.includes(r)).map((t) => t.id)]));
  const uncovered = Object.entries(coverage).filter(([, list]) => list.length === 0).map(([r]) => r);
  if (uncovered.length) throw blocked('REQUIREMENTS_UNTESTED', `필수 테스트가 없는 요구사항: ${uncovered.join(', ')}`);
  return { tests: tests.map((t) => ({ required: true, ...t })), coverage };
}
