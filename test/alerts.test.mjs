import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAlert, describeAlert } from '../engine/alerts.mjs';
import { reviewFindingsDecision, confirmReadyDecision, renderDecision } from '../engine/decisions.mjs';

const values = { AIWF_PROJECT_NAME: '쇼핑몰', AIWF_DOC_LANGUAGE: 'ko', AIWF_SLACK_USER_ID: 'U0123456789' };
const base = { featureId: 'FEAT-003', title: '주문 목록 상태 필터', requirementVersion: 'v1.0', designVersion: 'd1' };
const ev = (type, extra = {}) => ({ ...base, type, ...extra });

test('Slack 알림: 세 줄 형식과 플래그별 이모지', () => {
  assert.equal(formatAlert(ev('RUN_CREATED'), values), '🔵 *[쇼핑몰] | 기획 | 시작*\nFEAT-003 주문 목록 상태 필터 기획 시작.\n요구사항이 정리되면 승인을 요청합니다.');
  assert.match(formatAlert(ev('TASK_DONE', { taskId: 'TASK-002', data: { done: 2, total: 4, remaining: 2, taskTitle: '상태 필터 UI' } }), values),
    /^🔵 \*\[쇼핑몰\] \| 개발 \| 진행\*\n작업 2\/4 완료: TASK-002 상태 필터 UI\n남은 작업이 끝나면/);
  assert.match(formatAlert(ev('TASK_DONE', { taskId: 'TASK-004', data: { done: 4, total: 4, remaining: 0 } }), values), /\| 검수 \| 시작\*\n작업 4\/4 완료\. 검수 시작\./);
  const findings = ev('REVIEW_DONE', { status: 'CHANGES_REQUESTED', data: { findings: 2, high: 1 }, decision: reviewFindingsDecision('ko', { featureId: 'FEAT-003', findings: 2, high: 1 }) });
  assert.equal(formatAlert(findings, values), '<@U0123456789> 🟠 *[쇼핑몰] | 검수 | 확인 필요*\nCodex 지적 2건 (중요 1).\n할 일: Claude Code 에서 선택 — 고친다 / 그대로 넘긴다 / 다시 검수');
  assert.match(formatAlert(ev('REVIEW_FAILED', { reason: 'CODEX_NOT_FOUND' }), values), /^<@U0123456789> 🔴 \*\[쇼핑몰\] \| 검수 \| 오류\*/);
  const ready = ev('VERIFY_DONE', { status: 'PASS', data: { passed: 7, bad: 0 }, decision: confirmReadyDecision('ko', { featureId: 'FEAT-003' }) });
  assert.match(formatAlert(ready, values), /🟠 \*\[쇼핑몰\] \| 확정 \| 확인 필요\*\n검증 통과 \(통과 7건\)\. 확정만 남았습니다\.\n할 일: Claude Code 에서 선택 — 확정한다 \/ 더 확인한다/);
  assert.match(formatAlert(ev('RUN_DONE', { data: { docs: 2, firstDoc: 'docs/orders.md' } }), values),
    /^<@U0123456789> 🟢 \*\[쇼핑몰\] \| 문서 \| 완료\*\nFEAT-003 주문 목록 상태 필터 완료\. 문서 2개 \(docs\/orders\.md 외\)\.\n보고서: \.ai-workflow\/features\/FEAT-003\/report\.md/);
  assert.equal(formatAlert(ev('TASK_STARTED'), values), null);
});

test('Slack 알림: 모든 알림 이벤트에 단계·플래그가 있고, 영어 문서면 영어로 보낸다', () => {
  for (const type of ['RUN_CREATED', 'REQUIREMENTS_CONFIRMED', 'DESIGN_CONFIRMED', 'REQUIREMENTS_UPDATED', 'DESIGN_UPDATED', 'TASK_DONE', 'TASK_REOPENED', 'REVIEW_DONE', 'REVIEW_FAILED', 'REVIEW_ACCEPTED', 'VERIFY_DONE', 'CONFIRMED', 'RUN_DONE']) {
    const alert = describeAlert(ev(type, { data: {} }));
    assert.ok(alert?.stage && alert.flag && alert.line && alert.next, type);
  }
  assert.match(formatAlert(ev('RUN_CREATED'), { ...values, AIWF_DOC_LANGUAGE: 'en' }), /^🔵 \*\[쇼핑몰\] \| Plan \| Started\*\nFEAT-003 주문 목록 상태 필터: planning started\./);
});

test('확인 필요 블록: 선택지와 고른 뒤 실행할 명령, 승인 표시', () => {
  const text = renderDecision(confirmReadyDecision('ko', { featureId: 'FEAT-003' }));
  assert.match(text, /\[확인 필요\] 검수·검증이 모두 통과했습니다/);
  assert.match(text, /머리말: 확정/);
  assert.match(text, /1\. 확정한다 — .* \[승인\]\n {5}→ confirm --feature FEAT-003 --approval-text "<고른 선택지>" --user-confirmed/);
  assert.match(text, /AskUserQuestion/);
});

test('알림 수준 important: 기능 시작·완료와 확인 필요·오류만', async () => {
  const { isImportant } = await import('../engine/alerts.mjs');
  const keep = (e) => isImportant(e, describeAlert(e));
  assert.ok(keep(ev('RUN_CREATED')));
  assert.ok(keep(ev('RUN_DONE', { data: {} })));
  assert.ok(keep(ev('REVIEW_FAILED')));
  assert.ok(keep(ev('REVIEW_DONE', { status: 'CHANGES_REQUESTED', data: {} })));
  assert.ok(!keep(ev('TASK_DONE', { data: { done: 1, total: 3, remaining: 2 } })));
  assert.ok(!keep(ev('DESIGN_CONFIRMED', { data: {} })));
});
