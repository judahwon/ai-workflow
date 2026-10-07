// 테스트 실행기. 반환(공통): { status: 'PASS'|'FAIL'|'BLOCKED', code, message, log, actual }
// - command: 사용자가 승인한 명령을 셸로 실행한다 (checks.json·tests.json). 종료 코드 0 이면 통과.
// - http: 요청 하나를 보내고 상태·content-type·본문·JSON 경로 값을 비교한다. 리다이렉트는 따라가지 않는다.
// - browser: Playwright 로 선언형 단계를 실행한다 (headless). 스크립트·evaluate 단계는 없다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { redact } from './util.mjs';

export const LOG_CAP = 200 * 1024;
const BODY_CAP = 64 * 1024;
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|COOKIE|SESSION|PRIVATE)/i;

export function result(status, code, message, extra = {}) {
  return { status, code, message, log: '', actual: null, ...extra };
}

export function capText(text, max = LOG_CAP) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s) <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…[${Buffer.byteLength(s) - max} bytes 생략]…\n${s.slice(-half)}`;
}

// 로그에서 환경변수로 받은 비밀값과 토큰 형태 문자열을 지운다.
export function redactWith(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (typeof s === 'string' && s.length >= 3) out = out.split(s).join('[REDACTED]');
  return redact(out);
}

export function testSecrets(env) {
  return Object.entries(env).filter(([k]) => k.startsWith('AIWF_TEST_') || SECRET_ENV_NAME.test(k)).map(([, v]) => v);
}

function resolveEnvValue(value, env) {
  if (value && typeof value === 'object') {
    const v = env[value.fromEnv];
    if (typeof v !== 'string' || v === '') throw Object.assign(new Error(`환경변수 ${value.fromEnv} 가 없다.`), { code: 'ENV_MISSING' });
    return v;
  }
  return value;
}

// ---------- command ----------

export async function runCommand(item, io) {
  const { projectRoot, runProcess, env } = io;
  const cwd = path.join(projectRoot, ...(item.cwd ?? '.').split('/'));
  if (!fs.existsSync(cwd)) return result('BLOCKED', 'CWD_MISSING', `실행 폴더가 없다: ${item.cwd}`);
  const timeoutMs = (item.timeoutSec ?? 900) * 1000;
  const started = Date.now();
  const proc = await runProcess({
    command: item.command, shell: true, cwd, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0', CI: env.CI ?? '1' }, input: '', timeoutMs,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const log = capText(redactWith(`$ ${item.command}  (cwd: ${item.cwd ?? '.'})\n${proc.stdout ?? ''}${proc.stderr ? `\n[stderr]\n${proc.stderr}` : ''}\n[exit ${proc.exitCode}]`, testSecrets(env)));
  const actual = { exitCode: proc.exitCode ?? null, durationMs };
  if (proc.spawnError) return result('BLOCKED', 'SPAWN_FAILED', `실행 실패 (${proc.spawnError.code}).`, { log, actual });
  if (proc.timedOut) return result('BLOCKED', 'TIMEOUT', `시간 제한 ${item.timeoutSec ?? 900}초 초과.`, { log, actual });
  if (proc.outputLimitExceeded) return result('BLOCKED', 'OUTPUT_LIMIT', '출력 상한 초과로 중단했다.', { log, actual });
  if (proc.exitCode !== 0) return result('FAIL', 'EXIT_NONZERO', `종료 코드 ${proc.exitCode}.`, { log, actual });
  return result('PASS', 'OK', '종료 코드 0.', { log, actual });
}

// ---------- http ----------

function networkCode(e) {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'TIMEOUT';
  const c = e?.cause?.code ?? e?.code;
  return typeof c === 'string' ? c : 'NETWORK_ERROR';
}

async function readCapped(res, cap) {
  const buffer = Buffer.from(await res.arrayBuffer());
  return { text: buffer.subarray(0, cap).toString('utf8'), bytes: buffer.length, truncated: buffer.length > cap };
}

function jsonAt(data, p) {
  let cur = data;
  for (const seg of p.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return { exists: false };
    cur = cur[seg];
  }
  return { exists: true, value: cur };
}

export function checkResponse(x, { status, contentType = '', text = '', truncated = false }) {
  const mismatches = [];
  if (status !== x.status) mismatches.push(`status 기대 ${x.status}, 실제 ${status}`);
  if (x.contentType && !contentType.toLowerCase().includes(x.contentType.toLowerCase())) mismatches.push(`content-type 기대 ${x.contentType} 포함, 실제 ${contentType.slice(0, 80)}`);
  for (const s of x.bodyContains ?? []) if (!text.includes(s)) mismatches.push(`본문에 ${JSON.stringify(s.slice(0, 60))} 없음`);
  if (x.json) {
    let data;
    try { data = JSON.parse(text); } catch { mismatches.push(truncated ? '본문이 상한에서 잘려 JSON 검증 불가' : '본문이 JSON 이 아니다'); }
    if (data !== undefined) {
      for (const j of x.json) {
        const got = jsonAt(data, j.path);
        const ok = 'exists' in j ? got.exists === j.exists : got.exists && got.value === j.equals;
        if (!ok) mismatches.push(`json ${j.path} 기대 ${'exists' in j ? `exists=${j.exists}` : JSON.stringify(j.equals)}, 실제 ${got.exists ? redact(JSON.stringify(got.value)).slice(0, 80) : '(없음)'}`);
      }
    }
  }
  return mismatches;
}

export async function runHttp(test, io) {
  const { origins, env, fetchImpl = globalThis.fetch } = io;
  const r = test.request;
  const url = new URL(r.path, origins[r.origin]);
  const method = r.method ?? 'GET';
  let headers;
  try {
    headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k, resolveEnvValue(v, env)]));
  } catch (e) {
    return result('BLOCKED', 'ENV_MISSING', e.message);
  }
  let body;
  if (r.body !== undefined && r.body !== null) {
    body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    if (typeof r.body !== 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const timeoutMs = (test.timeoutSec ?? 30) * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  let content;
  try {
    res = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal: ac.signal });
    content = await readCapped(res, BODY_CAP);
  } catch (e) {
    const code = networkCode(e);
    if (code === 'TIMEOUT') return result('BLOCKED', 'TIMEOUT', `응답 시간 ${timeoutMs}ms 초과.`);
    return result('BLOCKED', 'SERVER_UNAVAILABLE', `${r.origin} (${url.origin}) 에 연결하지 못했다 (${code}). 서버가 떠 있는지 확인한다.`);
  } finally {
    clearTimeout(timer);
  }
  const contentType = res.headers.get('content-type') ?? '';
  const mismatches = checkResponse(test.expect, { status: res.status, contentType, text: content.text, truncated: content.truncated });
  const secrets = [...testSecrets(env), ...Object.values(headers)];
  const log = capText(redactWith([
    `${method} ${url.origin}${url.pathname}${url.search} → ${res.status}`,
    `content-type: ${contentType.slice(0, 120)}`,
    `본문 ${content.bytes} bytes${content.truncated ? ' (상한에서 잘림)' : ''}`,
    ...mismatches.map((m) => `불일치: ${m}`),
    '',
    content.text,
  ].join('\n'), secrets));
  const actual = { status: res.status, contentType: contentType.slice(0, 120), bodyBytes: content.bytes };
  if (mismatches.length) return result('FAIL', 'ASSERTION_FAILED', mismatches.slice(0, 5).join('; '), { log, actual });
  return result('PASS', 'OK', `${method} ${url.pathname} 기대 결과 일치.`, { log, actual });
}

// ---------- browser ----------

const MASK_SELECTORS = ['input[type=password]', '[data-sensitive]', 'input[name*=password i]', 'input[name*=token i]'];

// AIWF_PLAYWRIGHT_MODULE(절대 경로) 또는 프로젝트의 node_modules 에서 Playwright 를 찾는다.
export function loadPlaywright({ modulePath, projectRoot }) {
  const attempts = [];
  if (modulePath) attempts.push(() => createRequire(path.join(projectRoot, 'noop.js'))(modulePath));
  attempts.push(() => createRequire(path.join(projectRoot, 'package.json'))('playwright'));
  attempts.push(() => createRequire(path.join(projectRoot, 'package.json'))('@playwright/test'));
  for (const attempt of attempts) {
    try {
      const pw = attempt();
      if (pw?.chromium?.launch) return { chromium: pw.chromium };
    } catch { /* 다음 후보 */ }
  }
  return { error: modulePath ? `AIWF_PLAYWRIGHT_MODULE (${modulePath}) 에서 Playwright 를 불러오지 못했다.` : 'Playwright 를 찾지 못했다. .env 의 AIWF_PLAYWRIGHT_MODULE 에 playwright 패키지 폴더 절대 경로를 넣는다.' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (r.ok || Date.now() >= end) return r;
    await sleep(150);
  }
}

class AssertionFailure extends Error {}

export async function runBrowser(test, io) {
  const { origins, env, evidenceDir, playwright } = io;
  const pw = playwright ?? loadPlaywright({ modulePath: io.modulePath, projectRoot: io.projectRoot });
  if (pw.error) return result('BLOCKED', 'PLAYWRIGHT_MISSING', pw.error);
  const origin = origins[test.origin];
  const stepTimeout = 15000;
  const logs = [];
  const secrets = testSecrets(env);
  let browser;
  let page;
  const screenshot = async (name) => {
    if (!page || !evidenceDir) return null;
    try {
      fs.mkdirSync(evidenceDir, { recursive: true });
      const file = path.join(evidenceDir, name);
      await page.screenshot({ path: file, fullPage: true, mask: MASK_SELECTORS.map((s) => page.locator(s)) });
      return file;
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + (test.timeoutSec ?? 120) * 1000;
  try {
    try {
      browser = await pw.chromium.launch({ headless: true, ...(io.channel && io.channel !== 'chromium' ? { channel: io.channel } : {}) });
    } catch (e) {
      return result('BLOCKED', 'BROWSER_LAUNCH_FAILED', `브라우저를 띄우지 못했다 (${String(e?.message ?? e).split('\n')[0].slice(0, 160)}).`);
    }
    const context = await browser.newContext({ viewport: test.viewport ?? { width: 1280, height: 800 }, serviceWorkers: 'block' });
    page = await context.newPage();
    page.setDefaultTimeout(stepTimeout);
    for (const [index, step] of test.steps.entries()) {
      if (Date.now() > deadline) throw Object.assign(new Error('테스트 시간 제한 초과'), { code: 'TIMEOUT' });
      const label = `[${index + 1}] ${step.action}${step.selector ? ` ${step.selector}` : ''}${step.path ? ` ${step.path}` : ''}`;
      logs.push(label);
      const loc = step.selector ? page.locator(step.selector) : null;
      switch (step.action) {
        case 'goto': {
          const res = await page.goto(new URL(step.path, origin).href, { waitUntil: 'load', timeout: 30000 });
          logs.push(`    → ${res?.status() ?? '?'}`);
          break;
        }
        case 'fill': await loc.first().fill(step.valueFromEnv ? resolveEnvValue({ fromEnv: step.valueFromEnv }, env) : resolveEnvValue(step.value, env)); break;
        case 'click': await loc.first().click(); break;
        case 'press': await loc.first().press(step.key); break;
        case 'selectOption': await loc.first().selectOption(step.value); break;
        case 'check': await loc.first().check(); break;
        case 'expectVisible':
          try { await loc.first().waitFor({ state: 'visible', timeout: stepTimeout }); } catch { throw new AssertionFailure(`${label}: 보이지 않는다`); }
          break;
        case 'expectHidden':
          try { await loc.first().waitFor({ state: 'hidden', timeout: stepTimeout }); } catch { throw new AssertionFailure(`${label}: 아직 보인다`); }
          break;
        case 'expectText': {
          const r = await poll(async () => {
            const text = (await loc.first().textContent({ timeout: 1000 }).catch(() => null)) ?? '';
            return { ok: step.exact ? text.trim() === step.text : text.includes(step.text), text };
          }, stepTimeout);
          if (!r.ok) throw new AssertionFailure(`${label}: 기대 ${JSON.stringify(step.text)}, 실제 ${JSON.stringify(redactWith(r.text, secrets).slice(0, 120))}`);
          break;
        }
        case 'expectURL': {
          const r = await poll(async () => {
            const u = new URL(page.url());
            const actual = step.path.includes('?') ? `${u.pathname}${u.search}` : u.pathname;
            return { ok: actual === step.path, actual };
          }, stepTimeout);
          if (!r.ok) throw new AssertionFailure(`${label}: 실제 ${r.actual}`);
          break;
        }
        case 'expectCount': {
          const r = await poll(async () => {
            const count = await loc.count();
            return { ok: count === step.count, count };
          }, stepTimeout);
          if (!r.ok) throw new AssertionFailure(`${label}: 기대 ${step.count}개, 실제 ${r.count}개`);
          break;
        }
        default: throw new Error(`지원하지 않는 단계 ${step.action}`);
      }
    }
    const shot = await screenshot('final.png');
    return result('PASS', 'OK', `${test.steps.length}단계 통과.`, { log: capText(redactWith(logs.join('\n'), secrets)), actual: { screenshot: shot } });
  } catch (e) {
    const shot = await screenshot('failure.png');
    logs.push(`실패: ${String(e?.message ?? e).split('\n')[0]}`);
    const log = capText(redactWith(logs.join('\n'), secrets));
    if (e instanceof AssertionFailure) return result('FAIL', 'ASSERTION_FAILED', redactWith(e.message, secrets).slice(0, 500), { log, actual: { screenshot: shot } });
    if (e?.code === 'ENV_MISSING') return result('BLOCKED', 'ENV_MISSING', e.message, { log });
    if (e?.code === 'TIMEOUT' || e?.name === 'TimeoutError') return result('FAIL', 'TIMEOUT', `${logs.at(-2) ?? ''} 시간 초과`.trim(), { log, actual: { screenshot: shot } });
    const message = String(e?.message ?? e).split('\n')[0];
    if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(message)) return result('BLOCKED', 'SERVER_UNAVAILABLE', `${test.origin} (${origin}) 에 연결하지 못했다. 서버가 떠 있는지 확인한다.`, { log });
    return result('FAIL', 'STEP_FAILED', redactWith(message, secrets).slice(0, 500), { log, actual: { screenshot: shot } });
  } finally {
    try { await browser?.close(); } catch { /* 정리 실패는 무시 */ }
  }
}
