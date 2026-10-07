// Slack 알림 문구. 한 메시지는 세 줄이다.
//   🔵 *[프로젝트] | 단계 | 플래그*
//   한 줄 요약
//   다음 할 일 ("끝나면 ~" 또는 사람이 고를 때 "할 일: Claude Code 에서 선택 — …")
// 단계 이름은 터미널 status 와 같게, 플래그는 시작·진행·완료·확인 필요·오류 다섯 가지다.
// 자율 진행 중인 기능은 사용자를 부를 때(escalation)만 멘션한다. master 가 스스로 처리하는 일은 진행으로 알린다.
import { decisionSummary } from './decisions.mjs';

const L = (lang, ko, en) => (lang === 'en' ? en : ko);

export const FLAGS = {
  START: { emoji: '🔵', ko: '시작', en: 'Started' },
  PROGRESS: { emoji: '🔵', ko: '진행', en: 'In progress' },
  DONE: { emoji: '🟢', ko: '완료', en: 'Done' },
  ATTENTION: { emoji: '🟠', ko: '확인 필요', en: 'Needs you' },
  ERROR: { emoji: '🔴', ko: '오류', en: 'Error' },
};

const STAGES = {
  PLAN: { ko: '기획', en: 'Plan' },
  DESIGN: { ko: '설계', en: 'Design' },
  DEVELOP: { ko: '개발', en: 'Develop' },
  REVIEW: { ko: '검수', en: 'Review' },
  VERIFY: { ko: '확정', en: 'Verify' },
  DOCS: { ko: '문서', en: 'Docs' },
};

// 사람이 반응해야 하는 플래그. 사용자를 멘션하고, 알림 수준이 important 여도 보낸다.
const LOUD = new Set(['ATTENTION', 'ERROR']);

const PHASE_STAGE = { DISCUSS: 'PLAN', DESIGN: 'DESIGN', DEVELOP: 'DEVELOP', REVIEW: 'REVIEW', VERIFY: 'VERIFY', DOCS: 'DOCS', DONE: 'DOCS' };
const ESCALATION_STAGE = { REQUIREMENTS_UPDATED: 'PLAN', REVIEW_DONE: 'REVIEW', REVIEW_FAILED: 'REVIEW', VERIFY_DONE: 'VERIFY' };

// 사용자를 부르는 알림. 둘째 줄은 이유, 셋째 줄은 고를 선택지 또는 돌아와 달라는 요청.
function escalationAlert(event, lang) {
  const kind = event.escalation.kind;
  const stage = ESCALATION_STAGE[event.type] ?? PHASE_STAGE[event.phase] ?? 'DEVELOP';
  const flag = kind === 'blocked' ? 'ERROR' : 'ATTENTION';
  const prefix = {
    permission: L(lang, '권한 확인 대기', 'Waiting for permission'),
    stalled: L(lang, '세션 멈춤', 'Session stalled'),
    plan: L(lang, '기획 확인 필요', 'Plan needs you'),
    limit: L(lang, '재시도 상한', 'Retry limit'),
    blocked: L(lang, '진행 불가', 'Blocked'),
    confirm: L(lang, '완료 보고', 'Report'),
  }[kind];
  const line = `${prefix ? `${prefix}: ` : ''}${String(event.summary ?? '').split('\n')[0]}`.slice(0, 300);
  const next = event.decision
    ? decisionSummary(lang, event.decision)
    : L(lang, '할 일: Claude Code 로 돌아와 master 와 이야기해 주세요.', 'To do: come back to Claude Code and talk to the master.');
  return { stage, flag, line, next };
}

// 자율 진행 중 master 가 스스로 처리하는 일은 확인 필요가 아니라 진행으로 알린다.
function autonomousAlert(event, lang) {
  const d = event.data ?? {};
  switch (event.type) {
    case 'REQUIREMENTS_CONFIRMED':
      return { stage: 'DESIGN', flag: 'START', line: L(lang, `요구사항 ${event.requirementVersion ?? ''} 승인 (REQ ${d.requirements ?? '?'}개). 자율 진행 시작.`, `Requirements ${event.requirementVersion ?? ''} approved (${d.requirements ?? '?'} REQs). Autonomous run started.`), next: L(lang, '설계·개발·검수·검증을 마치면 확정을 요청합니다. 필요할 때만 부릅니다.', 'Will ask you to confirm when design, development, review and verification are done. You will be called only when needed.') };
    case 'DESIGN_CONFIRMED':
      return { stage: 'DEVELOP', flag: 'START', line: L(lang, `설계 ${event.designVersion ?? ''} ${d.byMaster ? 'master 승인' : '승인'} (작업 ${d.tasks ?? '?'}개). 개발 시작.`, `Design ${event.designVersion ?? ''} approved${d.byMaster ? ' by the master' : ''} (${d.tasks ?? '?'} tasks). Development started.`), next: L(lang, '작업을 순서대로 구현합니다. 끝나면 Codex 검수를 시작합니다.', 'Tasks will be implemented in order, then Codex review starts.') };
    case 'DESIGN_UPDATED':
      return { stage: 'DESIGN', flag: 'PROGRESS', line: L(lang, '설계·작업 목록이 바뀌어 설계 승인이 풀렸습니다.', 'Design or tasks changed; design approval was revoked.'), next: L(lang, 'master 가 확인하고 다시 승인합니다.', 'The master will check and approve again.') };
    case 'REVIEW_DONE':
      if (event.status === 'APPROVED') return null;
      return { stage: 'REVIEW', flag: 'PROGRESS', line: L(lang, `Codex 지적 ${d.findings ?? '?'}건 (중요 ${d.high ?? 0}) — master 가 고치는 중${d.round ? ` (${d.round}/${d.max})` : ''}.`, `Codex raised ${d.findings ?? '?'} finding(s) (${d.high ?? 0} high) — the master is fixing them${d.round ? ` (${d.round}/${d.max})` : ''}.`), next: L(lang, '고치고 나면 다시 검수합니다.', 'Will review again after the fix.') };
    case 'REVIEW_FAILED':
      return { stage: 'REVIEW', flag: 'ERROR', line: L(lang, `검수를 실행하지 못했습니다 (${event.reason ?? '원인 불명'}).`, `The review could not run (${event.reason ?? 'unknown'}).`), next: L(lang, 'master 가 다시 시도합니다.', 'The master will retry.') };
    case 'VERIFY_DONE':
      if (event.status === 'PASS') return null;
      return { stage: 'VERIFY', flag: 'PROGRESS', line: L(lang, `필수 검증 ${d.bad ?? '?'}건 실패 — master 가 고치는 중: ${(d.badIds ?? []).join(', ')}`, `${d.bad ?? '?'} required check(s) failed — the master is fixing them: ${(d.badIds ?? []).join(', ')}`), next: L(lang, '고치고 나면 다시 검증합니다.', 'Will verify again after the fix.') };
    case 'RESUMED':
      return { stage: PHASE_STAGE[event.phase] ?? 'DEVELOP', flag: 'PROGRESS', line: L(lang, '사용자 답변을 받아 재개했습니다.', 'Resumed with your answer.'), next: L(lang, 'master 가 이어서 진행합니다.', 'The master continues.') };
    default:
      return null;
  }
}

// 이벤트 → { stage, flag, line, next }. 알림 대상이 아니면 null.
export function describeAlert(event, lang = 'ko') {
  if (event.escalation) return escalationAlert(event, lang);
  if (event.autonomous) {
    const auto = autonomousAlert(event, lang);
    if (auto) return auto;
  }
  const d = event.data ?? {};
  const feature = `${event.featureId}${event.title ? ` ${event.title}` : ''}`;
  const next = (ko, en) => L(lang, ko, en);
  const decided = event.decision ? decisionSummary(lang, event.decision) : null;
  switch (event.type) {
    case 'RUN_CREATED':
      return { stage: 'PLAN', flag: 'START', line: L(lang, `${feature} 기획 시작.`, `${feature}: planning started.`), next: next('요구사항이 정리되면 승인을 요청합니다.', 'Will ask for approval once the requirements are ready.') };
    case 'REQUIREMENTS_CONFIRMED':
      return { stage: 'DESIGN', flag: 'START', line: L(lang, `요구사항 ${event.requirementVersion ?? ''} 승인 (REQ ${d.requirements ?? '?'}개). 설계 시작.`, `Requirements ${event.requirementVersion ?? ''} approved (${d.requirements ?? '?'} REQs). Design started.`), next: next('설계·작업 목록이 정리되면 승인을 요청합니다.', 'Will ask for approval once the design and tasks are ready.') };
    case 'DESIGN_CONFIRMED':
      return { stage: 'DEVELOP', flag: 'START', line: L(lang, `설계 ${event.designVersion ?? ''} 승인 (작업 ${d.tasks ?? '?'}개). 개발 시작.`, `Design ${event.designVersion ?? ''} approved (${d.tasks ?? '?'} tasks). Development started.`), next: next('작업을 순서대로 구현합니다. 끝나면 Codex 검수를 시작합니다.', 'Tasks will be implemented in order, then Codex review starts.') };
    case 'TASK_DONE':
      if (d.remaining > 0) {
        return { stage: 'DEVELOP', flag: 'PROGRESS', line: L(lang, `작업 ${d.done}/${d.total} 완료: ${event.taskId} ${d.taskTitle ?? ''}`.trim(), `Task ${d.done}/${d.total} done: ${event.taskId} ${d.taskTitle ?? ''}`.trim()), next: next('남은 작업이 끝나면 Codex 검수를 시작합니다.', 'Codex review starts when the remaining tasks are done.') };
      }
      return { stage: 'REVIEW', flag: 'START', line: L(lang, `작업 ${d.total ?? ''}/${d.total ?? ''} 완료. 검수 시작.`, `All ${d.total ?? ''} tasks done. Review started.`), next: next('Codex 검수 결과가 나오면 알립니다.', 'Will report when the Codex review finishes.') };
    case 'TASK_REOPENED':
      return { stage: 'DEVELOP', flag: 'START', line: L(lang, `${event.taskId} 다시 열림: ${event.reason ?? ''}`.trim(), `${event.taskId} reopened: ${event.reason ?? ''}`.trim()), next: next('고치고 나면 다시 검수합니다.', 'Will review again after the fix.') };
    case 'REQUIREMENTS_UPDATED':
      return { stage: 'PLAN', flag: 'ATTENTION', line: L(lang, '승인 이후 요구사항이 바뀌어 기획·설계 승인이 풀렸습니다.', 'Requirements changed after approval; plan and design approvals were revoked.'), next: decided ?? next('할 일: 바뀐 내용을 확인하고 다시 승인해 주세요.', 'To do: review the changes and approve again.') };
    case 'DESIGN_UPDATED':
      return { stage: 'DESIGN', flag: 'ATTENTION', line: L(lang, '승인 이후 설계·작업 목록이 바뀌어 설계 승인이 풀렸습니다.', 'Design or tasks changed after approval; design approval was revoked.'), next: decided ?? next('할 일: 바뀐 내용을 확인하고 다시 승인해 주세요.', 'To do: review the changes and approve again.') };
    case 'REVIEW_DONE':
      if (event.status === 'APPROVED') {
        return { stage: 'VERIFY', flag: 'START', line: L(lang, 'Codex 검수 통과. 검증 시작.', 'Codex review passed. Verification started.'), next: next('검증(테스트)이 끝나면 확정을 요청합니다.', 'Will ask you to confirm once verification finishes.') };
      }
      return { stage: 'REVIEW', flag: 'ATTENTION', line: L(lang, `Codex 지적 ${d.findings ?? '?'}건 (중요 ${d.high ?? 0}).`, `Codex raised ${d.findings ?? '?'} finding(s) (${d.high ?? 0} high).`), next: decided ?? next('할 일: 지적을 확인해 주세요.', 'To do: review the findings.') };
    case 'REVIEW_FAILED':
      return { stage: 'REVIEW', flag: 'ERROR', line: L(lang, `검수를 실행하지 못했습니다 (${event.reason ?? '원인 불명'}).`, `The review could not run (${event.reason ?? 'unknown'}).`), next: decided ?? next('할 일: 원인을 고치고 다시 검수해 주세요.', 'To do: fix the cause and review again.') };
    case 'REVIEW_ACCEPTED':
      return { stage: 'VERIFY', flag: 'START', line: L(lang, '검수를 사용자 허락으로 넘겼습니다. 검증 시작.', 'Review passed with your approval. Verification started.'), next: next('검증(테스트)이 끝나면 확정을 요청합니다.', 'Will ask you to confirm once verification finishes.') };
    case 'VERIFY_DONE':
      if (event.status !== 'PASS') {
        return { stage: 'VERIFY', flag: 'ATTENTION', line: L(lang, `필수 검증 ${d.bad ?? '?'}건 통과 못 함: ${(d.badIds ?? []).join(', ')}`, `${d.bad ?? '?'} required check(s) did not pass: ${(d.badIds ?? []).join(', ')}`), next: decided ?? next('할 일: 실패 원인을 확인해 주세요.', 'To do: look into the failures.') };
      }
      if (event.decision) {
        return { stage: 'VERIFY', flag: 'ATTENTION', line: L(lang, `검증 통과 (통과 ${d.passed ?? '?'}건). 확정만 남았습니다.`, `Verification passed (${d.passed ?? '?'} checks). Only confirmation is left.`), next: decided };
      }
      return { stage: 'VERIFY', flag: 'PROGRESS', line: L(lang, `검증${d.partial ? ' 일부' : ''} 통과 (통과 ${d.passed ?? '?'}건).`, `Verification${d.partial ? ' (partial)' : ''} passed (${d.passed ?? '?'} checks).`), next: next('전체 검증이 통과하면 확정을 요청합니다.', 'Will ask you to confirm when the full verification passes.') };
    case 'CONFIRMED':
      return { stage: 'DOCS', flag: 'START', line: L(lang, '기능 확정. 문서 작성 시작.', 'Feature confirmed. Writing docs.'), next: next(`${d.docsDir ?? 'docs'}/ 문서를 쓰고 나면 완료합니다.`, `Will finish after writing docs under ${d.docsDir ?? 'docs'}/.`) };
    case 'ESCALATED':
      return escalationAlert({ ...event, escalation: event.escalation ?? { kind: 'other' } }, lang);
    case 'RESUMED':
      return { stage: PHASE_STAGE[event.phase] ?? 'DEVELOP', flag: 'PROGRESS', line: L(lang, '사용자 답변을 받아 재개했습니다.', 'Resumed with your answer.'), next: L(lang, '이어서 진행합니다.', 'Continuing.') };
    case 'RUN_DONE':
      return { stage: 'DOCS', flag: 'DONE', line: L(lang, `${feature} 완료. 문서 ${d.docs ?? 0}개${d.firstDoc ? ` (${d.firstDoc}${d.docs > 1 ? ' 외' : ''})` : ''}.`, `${feature} done. ${d.docs ?? 0} doc(s)${d.firstDoc ? ` (${d.firstDoc}${d.docs > 1 ? ', …' : ''})` : ''}.`), next: L(lang, `보고서: .ai-workflow/features/${event.featureId}/report.md`, `Report: .ai-workflow/features/${event.featureId}/report.md`), mention: true };
    default:
      return null;
  }
}

// 알림 수준 important 에서도 보내는가. 스레드 첫 메시지(기능 시작)와 사람이 반응할 것, 기능 완료만 보낸다.
export function isImportant(event, alert) {
  if (event.escalation) return true;
  return event.type === 'RUN_CREATED' || event.type === 'RUN_DONE' || (!event.autonomous && LOUD.has(alert.flag));
}

export function formatAlert(event, values) {
  const lang = values.AIWF_DOC_LANGUAGE;
  const alert = describeAlert(event, lang);
  if (!alert) return null;
  const flag = FLAGS[alert.flag];
  // 자율 진행: 사용자를 부를 때만 멘션한다 (사용자가 CLI 로 돌아와야 하는 일). 그 밖에는 원래 규칙.
  const loud = event.autonomous ? Boolean(event.escalation) : Boolean(event.escalation) || alert.mention || LOUD.has(alert.flag);
  const mention = loud && values.AIWF_SLACK_USER_ID ? `<@${values.AIWF_SLACK_USER_ID}> ` : '';
  return [
    `${mention}${flag.emoji} *[${values.AIWF_PROJECT_NAME}] | ${STAGES[alert.stage][lang === 'en' ? 'en' : 'ko']} | ${flag[lang === 'en' ? 'en' : 'ko']}*`,
    alert.line,
    alert.next,
  ].join('\n');
}
