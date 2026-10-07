import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, serializeEnv, quoteValue } from '../engine/envfile.mjs';
import { validateConfig, looksLikeSecret, CONFIG_SECTIONS } from '../engine/config.mjs';

test('parseEnv: 주석·export·따옴표·인라인 주석', () => {
  const { values, duplicates } = parseEnv([
    '# 주석',
    '',
    'export A=plain # 뒤 주석',
    'B="큰 따옴표 \\"이스케이프\\" # 주석 아님"',
    "C='작은 #따옴표'",
    'D=',
    'A=again',
  ].join('\r\n'));
  assert.deepEqual(values, { A: 'again', B: '큰 따옴표 "이스케이프" # 주석 아님', C: '작은 #따옴표', D: '' });
  assert.deepEqual(duplicates, ['A']);
});

test('parseEnv: 형식 오류는 줄 번호와 함께 차단', () => {
  assert.throws(() => parseEnv('A=1\nnot a line'), /2번째 줄/);
  assert.throws(() => parseEnv('A="열린 따옴표'), /닫는 큰따옴표/);
  assert.throws(() => parseEnv('A="x" y'), /따옴표 뒤/);
});

test('serializeEnv → parseEnv 왕복', () => {
  const values = { AIWF_PROJECT_NAME: '이름 "따옴표" \\ 역슬래시 # 샵', AIWF_DOCS_DIR: 'docs/features' };
  const text = serializeEnv(CONFIG_SECTIONS, values);
  const parsed = parseEnv(text).values;
  assert.equal(parsed.AIWF_PROJECT_NAME, values.AIWF_PROJECT_NAME);
  assert.equal(parsed.AIWF_DOCS_DIR, 'docs/features');
  assert.equal(parsed.AIWF_SLACK_USER_ID, '');
  assert.equal(quoteValue('C:/x/y'), 'C:/x/y');
});

test('validateConfig: 필수·기본값', () => {
  const { values, errors } = validateConfig({});
  assert.deepEqual(errors.map((e) => [e.key, e.code]), [['AIWF_PROJECT_NAME', 'MISSING']]);
  assert.equal(values.AIWF_DOC_LANGUAGE, 'ko');
  assert.equal(values.AIWF_SLACK_ENABLED, 'false');
});

test('validateConfig: Slack 을 켜면 Slack 항목이 필수가 된다', () => {
  const { errors } = validateConfig({ AIWF_PROJECT_NAME: 'p', AIWF_SLACK_ENABLED: 'true' });
  assert.deepEqual(errors.map((e) => e.key).sort(), ['AIWF_SLACK_CHANNEL_ID', 'AIWF_SLACK_TOKEN_FILE', 'AIWF_SLACK_USER_ID', 'AIWF_SLACK_WORKSPACE']);
  const ok = validateConfig({
    AIWF_PROJECT_NAME: 'p',
    AIWF_SLACK_ENABLED: 'true',
    AIWF_SLACK_WORKSPACE: 'example.slack.com',
    AIWF_SLACK_USER_ID: 'U01ABCDEF',
    AIWF_SLACK_CHANNEL_ID: 'D01ABCDEF',
    AIWF_SLACK_TOKEN_FILE: process.platform === 'win32' ? 'C:\\secure\\bot.dpapi' : '/secure/bot.enc',
  });
  assert.deepEqual(ok.errors, []);
});

test('validateConfig: 형식 오류·알 수 없는 키·비밀값', () => {
  const { errors } = validateConfig({
    AIWF_PROJECT_NAME: 'p',
    AIWF_DOC_LANGUAGE: 'jp',
    AIWF_DOCS_DIR: '../outside',
    AIWF_CLAUDE_BIN: 'claude; rm',
    AIWF_ORGANIZATION: 'xoxb-1234567890-abcdefgh',
    OTHER: '1',
  });
  const byKey = Object.fromEntries(errors.map((e) => [e.key, e.code]));
  assert.equal(byKey.AIWF_DOC_LANGUAGE, 'INVALID');
  assert.equal(byKey.AIWF_DOCS_DIR, 'INVALID');
  assert.equal(byKey.AIWF_CLAUDE_BIN, 'INVALID');
  assert.equal(byKey.AIWF_ORGANIZATION, 'SECRET_VALUE');
  assert.equal(byKey.OTHER, 'UNKNOWN_KEY');
});

test('looksLikeSecret', () => {
  assert.ok(looksLikeSecret('xoxb-1234567890-abcdef'));
  assert.ok(looksLikeSecret('sk-abcdefghijklmnopqrstu'));
  assert.ok(looksLikeSecret('ghp_abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!looksLikeSecret('C:/Users/me/bot-token.dpapi'));
  assert.ok(!looksLikeSecret('U04ABCDEF'));
});
