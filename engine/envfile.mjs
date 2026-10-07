// .ai-workflow/.env 읽기·쓰기. 외부 의존성 없이 KEY=VALUE 형식만 다룬다.
// 지원: 주석(#), 빈 줄, `export ` 접두, 큰따옴표(\" \\ \n 이스케이프), 작은따옴표(이스케이프 없음),
// 따옴표 없는 값의 ` #` 뒤 주석. 여러 줄 값은 지원하지 않는다.
import fs from 'node:fs';
import { WorkflowError, atomicWriteFile } from './util.mjs';

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function parseValue(raw, lineNo) {
  if (raw.startsWith('"')) {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\') {
        const next = raw[++i];
        if (next === 'n') out += '\n';
        else if (next === '"' || next === '\\') out += next;
        else throw envError(lineNo, '알 수 없는 이스케이프');
      } else if (ch === '"') {
        const rest = raw.slice(i + 1).trim();
        if (rest && !rest.startsWith('#')) throw envError(lineNo, '닫는 따옴표 뒤에 값이 있다');
        return out;
      } else {
        out += ch;
      }
    }
    throw envError(lineNo, '닫는 큰따옴표가 없다');
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    if (end < 0) throw envError(lineNo, '닫는 작은따옴표가 없다');
    const rest = raw.slice(end + 1).trim();
    if (rest && !rest.startsWith('#')) throw envError(lineNo, '닫는 따옴표 뒤에 값이 있다');
    return raw.slice(1, end);
  }
  const commentAt = raw.search(/\s#/);
  return (commentAt >= 0 ? raw.slice(0, commentAt) : raw).trim();
}

function envError(lineNo, message) {
  return new WorkflowError('ENV_PARSE_ERROR', `.env ${lineNo}번째 줄: ${message}`, { exitCode: 3 });
}

// 반환: { values: {KEY: value}, duplicates: [KEY] }
export function parseEnv(text) {
  const values = {};
  const duplicates = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (!line.trim() || line.trim().startsWith('#')) return;
    const match = LINE_RE.exec(line);
    if (!match) throw envError(lineNo, 'KEY=VALUE 형식이 아니다');
    const [, key, raw] = match;
    if (key in values) duplicates.push(key);
    values[key] = parseValue(raw, lineNo);
  });
  return { values, duplicates };
}

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return { exists: false, values: {}, duplicates: [] };
  return { exists: true, ...parseEnv(fs.readFileSync(file, 'utf8')) };
}

export function quoteValue(value) {
  const text = String(value);
  if (text === '') return '';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// sections: [{ title, keys: [{ name, description }] }]. 값이 없는 키도 빈 값으로 남겨 무엇을 채울지 보이게 한다.
export function serializeEnv(sections, values, { header = [] } = {}) {
  const lines = [...header.map((l) => `# ${l}`)];
  for (const section of sections) {
    if (lines.length) lines.push('');
    lines.push(`# ===== ${section.title} =====`);
    for (const key of section.keys) {
      for (const d of key.description.split('\n')) lines.push(`# ${d}`);
      lines.push(`${key.name}=${quoteValue(values[key.name] ?? '')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function writeEnvFile(file, content) {
  atomicWriteFile(file, content);
}
