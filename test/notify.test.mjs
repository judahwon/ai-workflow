import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configuredProject, tempDir } from './helpers.mjs';
import { createContext } from '../engine/context.mjs';
import { appendEvent } from '../engine/events.mjs';
import { flushNotifications, describeFlush, selectAttachments } from '../engine/notify.mjs';

// Slack 이 켜진 프로젝트와, 전송 스크립트 대신 페이로드만 기록하는 가짜 전송.
async function slackProject(screenshots, { filesReply = { ok: true, files: 1 } } = {}) {
  const p = await configuredProject();
  const tokenFile = path.join(tempDir('aiwf-token-'), 'bot.dpapi');
  fs.writeFileSync(tokenFile, '00');
  const r = await p.run('init', '--set', 'AIWF_SLACK_ENABLED=true', '--set', 'AIWF_SLACK_WORKSPACE=example.slack.com',
    '--set', 'AIWF_SLACK_USER_ID=U01ABCDEF', '--set', 'AIWF_SLACK_CHANNEL_ID=D01ABCDEF', '--set', `AIWF_SLACK_TOKEN_FILE=${tokenFile}`,
    '--set', `AIWF_SLACK_SCREENSHOTS=${screenshots}`);
  assert.equal(r.code, 0, r.out);
  const payloads = [];
  let ts = 0;
  const runProcess = async ({ args }) => {
    const payload = JSON.parse(fs.readFileSync(args[args.indexOf('-PayloadFile') + 1], 'utf8'));
    payloads.push(payload);
    const out = payload.files ? filesReply : { ok: true, ts: `1700000000.00000${++ts}` };
    return { exitCode: out.ok ? 0 : 5, stdout: `${JSON.stringify(out)}\n`, stderr: '' };
  };
  const ctx = createContext({ ...p.overrides, platform: 'win32', runProcess });
  const run = { runId: 'RUN-1', featureId: 'FEAT-001', title: '목록', phase: 'VERIFY' };
  const shot = (rel, bytes = 10) => {
    const abs = path.join(p.workflowRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(bytes, 1));
    return rel;
  };
  return { p, ctx, run, payloads, shot };
}

const verifyEvent = (attachments) => ({ type: 'VERIFY_DONE', status: 'FAIL', summary: '검증 V001: 실패 1', data: { passed: 0, bad: 1, badIds: ['TEST-001'] }, attachments });

test('Slack 첨부: 본문 뒤에 같은 스레드로 이미지를 올리고, 설정으로 고른다', async () => {
  const { ctx, run, payloads, shot } = await slackProject('failures');
  const failure = shot('runs/RUN-1/verify/V001/TEST-001/failure.png');
  const final = shot('runs/RUN-1/verify/V001/TEST-002/final.png');
  appendEvent(ctx, run, verifyEvent([
    { path: failure, title: 'TEST-001 목록 — FAIL', kind: 'failure' },
    { path: final, title: 'TEST-002 상세', kind: 'final' },
    { path: '../outside.png', title: '밖', kind: 'failure' },
  ]));
  const result = await flushNotifications(ctx);
  assert.match(describeFlush(result), /보냄 1 \(이미지 첨부 1건\)/);
  assert.equal(payloads.length, 2);
  assert.ok(payloads[0].text, '본문을 먼저 보낸다');
  assert.equal(payloads[1].threadTs, '1700000000.000001', '이미지는 실행 스레드에 붙인다');
  assert.deepEqual(payloads[1].files.map((f) => f.title), ['TEST-001 목록 — FAIL'], 'failures 면 실패 화면만, runs/ 밖 파일은 빼고');
  assert.equal(payloads[1].files[0].path, path.join(ctx.workflowRoot, failure));

  ctx.config.values.AIWF_SLACK_SCREENSHOTS = 'all';
  assert.equal(selectAttachments(ctx, verifyEvent([{ path: failure, kind: 'failure' }, { path: final, kind: 'final' }])).length, 2);
  ctx.config.values.AIWF_SLACK_SCREENSHOTS = 'off';
  assert.equal(selectAttachments(ctx, verifyEvent([{ path: failure, kind: 'failure' }])).length, 0);
});

test('Slack 첨부: 업로드가 실패하면 다시 보내지 않고 파일 위치를 한 줄로 알린다', async () => {
  const { ctx, run, payloads, shot } = await slackProject('all', { filesReply: { ok: false, httpStatus: 200, slackError: 'missing_scope' } });
  const failure = shot('runs/RUN-1/verify/V001/TEST-001/failure.png');
  appendEvent(ctx, run, verifyEvent([{ path: failure, title: 'TEST-001', kind: 'failure' }]));
  const result = await flushNotifications(ctx);
  assert.equal(result.runs[0].sent, 1, '본문은 보낸 것으로 친다');
  assert.equal(payloads.length, 3);
  assert.match(payloads[2].text, /이미지 1장 전송 실패 \(missing_scope\) \(Slack 앱에 files:write 권한이 필요하다\) — 파일: \.ai-workflow\/runs\/RUN-1\/verify\/V001\/TEST-001/);
  payloads.length = 0;
  await flushNotifications(ctx);
  assert.equal(payloads.length, 0, '다시 flush 해도 이미지를 또 보내지 않는다');
});

test('Slack 첨부: 첨부가 없거나 큰 파일은 본문만 보낸다', async () => {
  const { ctx, run, payloads, shot } = await slackProject('all');
  const big = shot('runs/RUN-1/verify/V001/TEST-001/failure.png', 11 * 1024 * 1024);
  appendEvent(ctx, run, verifyEvent([{ path: big, kind: 'failure' }]));
  appendEvent(ctx, run, verifyEvent([]));
  await flushNotifications(ctx);
  assert.equal(payloads.length, 2);
  assert.ok(payloads.every((x) => x.text && !x.files));
});
