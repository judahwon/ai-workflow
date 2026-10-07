// 공용 유틸: 식별자 검증, 해시, 원자적 저장, append-only JSONL, 비밀값 마스킹.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ID_PATTERNS = Object.freeze({
  feature: /^FEAT-\d{3}$/,
  run: /^RUN-\d{8}-\d{3}$/,
  task: /^TASK-\d{3}$/,
  requirement: /^REQ-\d{3}$/,
  test: /^TEST-\d{3}$/,
});

// exitCode: 1 오류, 2 사용법, 3 차단(BLOCKED), 4 잠금
export class WorkflowError extends Error {
  constructor(code, message, { exitCode = 1, details } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function blocked(code, message, details) {
  return new WorkflowError(code, message, { exitCode: 3, details });
}

export function usageError(message) {
  return new WorkflowError('USAGE', message, { exitCode: 2 });
}

export function safeShow(value) {
  return JSON.stringify(String(value).slice(0, 40));
}

export function isValidId(kind, value) {
  return typeof value === 'string' && ID_PATTERNS[kind].test(value);
}

export function assertId(kind, value) {
  if (!isValidId(kind, value)) {
    throw new WorkflowError('INVALID_ID', `${kind} ID 형식 오류: ${safeShow(value)}`, { exitCode: 2 });
  }
  return value;
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashJson(value) {
  return sha256(canonicalJson(value));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows에서 백신·인덱서가 파일을 잡고 있으면 rename이 일시적으로 실패한다.
export function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(50 * (i + 1));
    }
  }
}

export function atomicWriteFile(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameWithRetry(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 임시 파일 정리 실패는 무시 */ }
    throw e;
  }
}

export function writeJsonAtomic(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new WorkflowError('NOT_FOUND', `파일 없음: ${path.basename(file)}`);
    throw e;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new WorkflowError('STATE_CORRUPT', `JSON 파싱 실패: ${path.basename(file)}`);
  }
}

// append-only 기록. 비정상 종료로 마지막 줄이 잘렸으면 줄바꿈부터 붙여 다음 기록을 보존한다.
export function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = '';
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${prefix}${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return { records: [], invalidLines: 0 };
  const records = [];
  let invalidLines = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidLines++;
    }
  }
  return { records, invalidLines };
}

const REDACTIONS = [
  [/xox[abposre]-[A-Za-z0-9-]+/g, 'xox?-[REDACTED]'],
  [/xapp-[A-Za-z0-9-]+/g, 'xapp-[REDACTED]'],
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_[REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/(api[_-]?key|token|secret|password|passwd|cookie|authorization|xsrf|csrf)(["'\s]*[:=]\s*["']?)([^\s"',;]{4,})/gi, '$1$2[REDACTED]'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

export function samePath(a, b, platform = process.platform) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// child가 parent 내부(또는 동일)이면 true
export function isInside(parent, child, platform = process.platform) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  if (first === '..') return false;
  return platform === 'win32' ? !/^[a-zA-Z]:/.test(rel) : true;
}

export function decodeUtf8Strict(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}
