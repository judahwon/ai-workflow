// 기능 문서(요구사항·설계) 읽기. 승인은 파일 바이트 sha256 에 묶인다.
import fs from 'node:fs';
import path from 'node:path';
import { blocked, isInside, sha256 } from './util.mjs';

// 한국어·영어 문서 모두 지원한다.
const VERSION_LABELS = {
  requirements: ['명세 버전', 'Spec version'],
  design: ['설계 버전', 'Design version'],
};
const OPEN_QUESTION_HEADINGS = ['미결 질문', 'Open questions'];

export function featureDir(ctx, featureId) {
  return path.join(ctx.workflowRoot, 'features', featureId);
}

export function featureFile(ctx, featureId, name) {
  return path.join(featureDir(ctx, featureId), name);
}

export function readVersion(text, kind) {
  for (const label of VERSION_LABELS[kind]) {
    const match = new RegExp(`^${label}:[ \\t]*(\\S.*)$`, 'mi').exec(text);
    if (match) return match[1].trim();
  }
  return null;
}

// "## 미결 질문" 구간의 "- Q-###" 항목. 해결한 질문은 결정 기록으로 옮기고 지운다.
export function readOpenQuestions(text) {
  const lines = text.split(/\r?\n/);
  const open = [];
  let inSection = false;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (heading) {
      inSection = OPEN_QUESTION_HEADINGS.some((h) => heading[1].toLowerCase().startsWith(h.toLowerCase()));
      continue;
    }
    if (!inSection) continue;
    const item = /^\s*[-*]\s+(Q-\d{3})\b/.exec(line);
    if (item) open.push(item[1]);
  }
  return open;
}

export function readDocument(ctx, featureId, name) {
  const abs = featureFile(ctx, featureId, name);
  if (!isInside(featureDir(ctx, featureId), abs)) throw blocked('STATE_CORRUPT', '문서 경로가 기능 폴더 밖이다.');
  if (!fs.existsSync(abs)) throw blocked('DOCUMENT_MISSING', `문서 없음: features/${featureId}/${name}`);
  const st = fs.lstatSync(abs);
  if (!st.isFile() || st.isSymbolicLink()) throw blocked('DOCUMENT_NOT_FILE', `일반 파일이 아니다: ${name}`);
  const buf = fs.readFileSync(abs);
  return { abs, buf, text: buf.toString('utf8'), hash: sha256(buf) };
}

export function readRequirements(ctx, featureId) {
  const doc = readDocument(ctx, featureId, 'requirements.md');
  return {
    ...doc,
    version: readVersion(doc.text, 'requirements'),
    requirementIds: [...new Set(doc.text.match(/\bREQ-\d{3}\b/g) ?? [])].sort(),
    openQuestions: readOpenQuestions(doc.text),
  };
}

export function readDesign(ctx, featureId) {
  const doc = readDocument(ctx, featureId, 'design.md');
  return { ...doc, version: readVersion(doc.text, 'design'), openQuestions: readOpenQuestions(doc.text) };
}

// 파일이 없으면 null (상태 표시용).
export function hashIfExists(ctx, featureId, name) {
  try {
    return readDocument(ctx, featureId, name).hash;
  } catch {
    return null;
  }
}
