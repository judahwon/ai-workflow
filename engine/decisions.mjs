// 사용자가 골라야 하는 순간(확인 필요)의 질문과 선택지.
// 엔진이 선택지를 정하고, CLI 출력의 [확인 필요] 블록과 Slack 알림의 "할 일" 줄이 같은 내용을 쓴다.
// Claude Code 세션(aiwf 스킬)은 이 블록을 보면 AskUserQuestion 객관식으로 묻고, 고른 선택지의 명령을 실행한다.

const L = (lang, ko, en) => (lang === 'en' ? en : ko);

// 선택지: { label, description, command } — command 는 고른 뒤 세션이 할 일 (엔진 명령 또는 행동).
// approval: true 면 고른 답이 사용자 승인이다. 고른 선택지 이름을 --approval-text 로 그대로 넘긴다.
function decision(id, header, question, options) {
  return { id, header, question, options };
}

export function reviewFindingsDecision(lang, { featureId, findings, high }) {
  return decision('REVIEW_FINDINGS', L(lang, '검수 지적', 'Review'),
    L(lang, `Codex 검수 지적 ${findings}건 (중요 ${high}건)을 어떻게 할까요?`, `Codex raised ${findings} finding(s) (${high} high). What next?`), [
      { label: L(lang, '고친다', 'Fix'), description: L(lang, '지적된 작업을 다시 열어 고친 뒤 다시 검수한다.', 'Reopen the affected task, fix it, then review again.'), command: `task-reopen --feature ${featureId} --task <TASK-###> --reason "<지적 요약>"` },
      { label: L(lang, '그대로 넘긴다', 'Accept as is'), description: L(lang, '지적을 남겨 두고 검수를 넘긴다. 이 선택이 승인 기록이 된다.', 'Keep the findings and pass review. This choice is recorded as approval.'), command: `review-accept --feature ${featureId} --approval-text "<고른 선택지>" --user-confirmed`, approval: true },
      { label: L(lang, '다시 검수', 'Review again'), description: L(lang, '지적이 맞지 않다고 보면 검수를 다시 돌린다.', 'If the findings look wrong, run the review again.'), command: `review --feature ${featureId}` },
    ]);
}

export function reviewErrorDecision(lang, { featureId, code }) {
  return decision('REVIEW_ERROR', L(lang, '검수 오류', 'Review'),
    L(lang, `검수를 실행하지 못했습니다 (${code}). 어떻게 할까요?`, `The review could not run (${code}). What next?`), [
      { label: L(lang, '고치고 다시', 'Fix and retry'), description: L(lang, '로그인·codex 경로 등 원인을 고친 뒤 검수를 다시 돌린다.', 'Fix the cause (login, codex path) and run the review again.'), command: `review --feature ${featureId}` },
      { label: L(lang, '검수 없이 넘긴다', 'Skip review'), description: L(lang, 'Codex 검수 없이 넘긴다. 이 선택이 승인 기록이 된다.', 'Pass without a Codex review. This choice is recorded as approval.'), command: `review-accept --feature ${featureId} --approval-text "<고른 선택지>" --user-confirmed`, approval: true },
    ]);
}

export function verifyFailedDecision(lang, { featureId, failed, manual }) {
  const options = [
    { label: L(lang, '작업 다시 열기', 'Reopen task'), description: L(lang, '실패 원인이 코드면 해당 작업을 다시 열어 고친다.', 'If the code is at fault, reopen the task and fix it.'), command: `task-reopen --feature ${featureId} --task <TASK-###> --reason "<실패 요약>"` },
    { label: L(lang, '실패만 다시 실행', 'Rerun failures'), description: L(lang, '일시적인 실패면 실패한 항목만 다시 실행한다.', 'If it was flaky, rerun only the failed items.'), command: `verify --feature ${featureId} ${failed.map((id) => `--only ${id}`).join(' ')}`.trim() },
    { label: L(lang, '검사 설정 고치기', 'Fix checks'), description: L(lang, '검사 명령·서버 주소가 잘못됐으면 checks.json 을 고친다 (승인 필요).', 'If a check command or server address is wrong, update checks.json (needs approval).'), command: 'checks-set --from <JSON> --approval-text "<사용자 답변>" --user-confirmed' },
  ];
  if (manual.length) {
    options.unshift({ label: L(lang, '수동 테스트 확인', 'Confirm manual tests'), description: L(lang, `사람이 확인할 테스트(${manual.join(', ')})를 직접 확인하고 결과를 기록한다.`, `Check the manual tests (${manual.join(', ')}) and record the result.`), command: `test-confirm --feature ${featureId} --test <TEST-###> --approval-text "<사용자 답변>" --user-confirmed` });
  }
  return decision('VERIFY_FAILED', L(lang, '검증 실패', 'Verify'),
    L(lang, `필수 검증 ${failed.length + manual.length}건이 통과하지 못했습니다. 어떻게 할까요?`, `${failed.length + manual.length} required check(s) did not pass. What next?`), options.slice(0, 4));
}

export function confirmReadyDecision(lang, { featureId }) {
  return decision('CONFIRM_READY', L(lang, '확정', 'Confirm'),
    L(lang, '검수·검증이 모두 통과했습니다. 기능을 확정할까요?', 'Review and verification passed. Confirm the feature?'), [
      { label: L(lang, '확정한다', 'Confirm'), description: L(lang, '지금 코드로 확정하고 문서 단계로 간다. 이 선택이 승인 기록이 된다.', 'Confirm with the current code and move to docs. This choice is recorded as approval.'), command: `confirm --feature ${featureId} --approval-text "<고른 선택지>" --user-confirmed`, approval: true },
      { label: L(lang, '더 확인한다', 'Not yet'), description: L(lang, '확정을 미루고 직접 더 확인한다.', 'Hold off and check more yourself.'), command: '(대기)' },
    ]);
}

export function approvalDriftDecision(lang, { featureId, plan, reason }) {
  const phase = plan ? 'plan' : 'design';
  return decision('APPROVAL_DRIFT', L(lang, '승인 풀림', 'Approval'),
    L(lang, `승인 이후 ${plan ? '요구사항' : '설계·작업 목록'}이 바뀌어 승인이 풀렸습니다 (${reason}). 어떻게 할까요?`, `The ${plan ? 'requirements' : 'design/tasks'} changed after approval (${reason}), so approval was revoked. What next?`), [
      { label: L(lang, '바뀐 내용으로 승인', 'Approve changes'), description: L(lang, '바뀐 내용을 보여 드리고 다시 승인받는다.', 'Show the changes and approve again.'), command: `approve --feature ${featureId} --phase ${phase} --approval-text "<고른 선택지>" --user-confirmed`, approval: true },
      { label: L(lang, '변경 되돌리기', 'Revert changes'), description: L(lang, '문서를 승인된 내용으로 되돌린다 (git 기록 기준).', 'Restore the approved documents (from git history).'), command: '(문서를 되돌린 뒤 status 로 확인)' },
    ]);
}

export function outOfScopeDecision(lang, { featureId, taskId, files, docs = false }) {
  const label = docs ? L(lang, '문서 폴더 밖', 'outside the docs folder') : L(lang, `${taskId} 의 수정 범위 밖`, `outside ${taskId}'s scope`);
  const retry = docs
    ? `docs-done --feature ${featureId} --summary "<쓴 문서>" --extra-approved "<고른 선택지>" --user-confirmed`
    : `task-done --feature ${featureId} --task ${taskId} --summary "<변경 내용>" --extra-approved "<고른 선택지>" --user-confirmed`;
  const options = [
    { label: L(lang, '허락한다', 'Allow'), description: L(lang, `바뀐 파일(${files.slice(0, 3).join(', ')}${files.length > 3 ? ' 외' : ''})을 그대로 인정한다. 이 선택이 승인 기록이 된다.`, `Accept the changed files (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}). This choice is recorded as approval.`), command: retry, approval: true },
    { label: L(lang, '되돌린다', 'Revert'), description: L(lang, '범위 밖 변경을 되돌리고 다시 완료한다.', 'Revert the out-of-scope changes and finish again.'), command: '(범위 밖 변경을 되돌린 뒤 같은 명령을 다시 실행)' },
  ];
  if (!docs) options.push({ label: L(lang, '범위를 고친다', 'Change scope'), description: L(lang, 'tasks.json 의 수정 범위를 고치고 설계를 다시 승인받는다.', 'Update allowedFiles in tasks.json and re-approve the design.'), command: '(tasks.json 수정 → approve --phase design)' });
  return decision('OUT_OF_SCOPE', L(lang, '범위 밖 변경', 'Scope'),
    L(lang, `${label} 파일 ${files.length}개가 바뀌었습니다. 어떻게 할까요?`, `${files.length} file(s) ${label} changed. What next?`), options);
}

export function docsEmptyDecision(lang, { featureId, docsDir }) {
  return decision('DOCS_EMPTY', L(lang, '문서 없음', 'Docs'),
    L(lang, `${docsDir}/ 에 바뀐 문서가 없습니다. 어떻게 할까요?`, `No document changed under ${docsDir}/. What next?`), [
      { label: L(lang, '문서를 쓴다', 'Write docs'), description: L(lang, `확정된 내용으로 ${docsDir}/ 문서를 쓰거나 고친다.`, `Write or update docs under ${docsDir}/.`), command: `docs-done --feature ${featureId} --summary "<쓴 문서>"` },
      { label: L(lang, '문서 필요 없음', 'No docs needed'), description: L(lang, '이 기능은 문서가 필요 없다. 이 선택이 승인 기록이 된다.', 'This feature needs no docs. This choice is recorded as approval.'), command: `docs-done --feature ${featureId} --summary "문서 없음" --no-docs-approved "<고른 선택지>" --user-confirmed`, approval: true },
    ]);
}

// CLI 출력 블록. aiwf 스킬이 이 형식을 보고 AskUserQuestion 으로 묻는다.
export function renderDecision(d) {
  return [
    '',
    `[확인 필요] ${d.question}`,
    `  머리말: ${d.header}`,
    ...d.options.map((o, i) => `  ${i + 1}. ${o.label} — ${o.description}${o.approval ? ' [승인]' : ''}\n     → ${o.command}`),
    '  (AskUserQuestion 으로 위 선택지를 그대로 묻고, 고른 선택지의 명령을 실행한다.)',
  ].join('\n');
}

// Slack 의 "할 일" 줄.
export function decisionSummary(lang, d) {
  return L(lang, `할 일: Claude Code 에서 선택 — ${d.options.map((o) => o.label).join(' / ')}`, `To do: choose in Claude Code — ${d.options.map((o) => o.label).join(' / ')}`);
}
