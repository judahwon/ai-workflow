// 문서 단계: 확정 이후 문서 폴더(AIWF_DOCS_DIR)에 쓴 문서를 확인하고, 기능 보고서(report.md)를 남긴 뒤 완료한다.
import fs from 'node:fs';
import path from 'node:path';
import { blocked, usageError, atomicWriteFile, redact } from './util.mjs';
import { withLock } from './lock.mjs';
import { appendEvent } from './events.mjs';
import { requireValidConfig, requireEnvIgnored } from './config.mjs';
import { resolveRun, saveRun, PHASE_LABELS } from './runs.mjs';
import { outOfScopeDecision, docsEmptyDecision } from './decisions.mjs';
import { featureDir } from './documents.mjs';
import { changedSinceBaseline, classifyChanges } from './scope.mjs';
import { ignoreCase } from './develop.mjs';
import { featureChanges } from './review.mjs';

const LABELS = {
  ko: {
    title: '기능 보고서', project: '프로젝트', run: '실행', done: '완료', approvals: '승인', plan: '기획', design: '설계',
    tasks: '작업', files: '바뀐 파일', extra: '사용자 허락으로 범위 밖', review: '검수', verify: '검증', confirm: '확정', docs: '문서', none: '없음',
    accepted: '사용자 허락으로 넘김', reopened: '다시 연 횟수',
  },
  en: {
    title: 'Feature report', project: 'Project', run: 'Run', done: 'Completed', approvals: 'Approvals', plan: 'Plan', design: 'Design',
    tasks: 'Tasks', files: 'Changed files', extra: 'out of scope, approved by user', review: 'Review', verify: 'Verification', confirm: 'Confirmation', docs: 'Docs', none: 'none',
    accepted: 'accepted by user', reopened: 'reopened',
  },
};

export function renderReport(ctx, run) {
  const values = ctx.config.values;
  const L = LABELS[values.AIWF_DOC_LANGUAGE] ?? LABELS.ko;
  const { plan, design } = run.approvals;
  const lines = [
    `# ${L.title} — ${run.featureId} ${run.title}`,
    '',
    `- ${L.project}: ${values.AIWF_PROJECT_NAME}${values.AIWF_ORGANIZATION ? ` (${values.AIWF_ORGANIZATION})` : ''}`,
    `- ${L.run}: ${run.runId} · ${run.createdAt.slice(0, 10)} → ${(run.docs?.finishedAt ?? ctx.now()).slice(0, 10)}`,
    '',
    `## ${L.approvals}`,
    `- ${L.plan}: #${plan.seq} v${String(plan.version).replace(/^v/, '')} — ${plan.requirementIds.join(', ')} (${plan.approvedAt})`,
    `- ${L.design}: #${design.seq} v${String(design.version).replace(/^v/, '')} (${design.approvedAt})`,
    '',
    `## ${L.tasks}`,
  ];
  for (const id of design.order) {
    const contract = design.tasks[id].contract;
    const state = run.tasks[id];
    const attempt = state.attempts?.at(-1);
    lines.push(`- ${id} ${contract.title} (${contract.requirementIds.join(', ')})${state.reopened?.length ? ` — ${L.reopened} ${state.reopened.length}` : ''}`);
    if (attempt?.summary) lines.push(`  - ${attempt.summary}`);
  }
  const { files } = featureChanges(run);
  lines.push('', `## ${L.files}`, ...(files.length ? files.map((f) => `- ${f}`) : [`- ${L.none}`]));
  const extra = design.order.flatMap((id) => run.tasks[id].attempts?.flatMap((a) => a.extraApproved?.files ?? []) ?? []);
  if (extra.length) lines.push(`- (${L.extra}: ${[...new Set(extra)].join(', ')})`);
  lines.push('', `## ${L.review}`);
  const outcome = run.reviewOutcome;
  const review = outcome?.reviewSeq ? run.reviews?.find((r) => r.seq === outcome.reviewSeq) : null;
  if (review) lines.push(`- R${String(review.seq).padStart(3, '0')} ${review.verdict}: ${review.summary}`);
  if (outcome?.type === 'ACCEPTED') lines.push(`- ${L.accepted}: "${outcome.approvalText}"`);
  if (!outcome) lines.push(`- ${L.none}`);
  const verification = run.verifications?.find((v) => v.seq === run.confirmation?.verificationSeq);
  lines.push('', `## ${L.verify}`);
  if (verification) {
    lines.push(`- V${String(verification.seq).padStart(3, '0')} (${verification.at})`);
    for (const r of verification.results) lines.push(`  - ${r.status} ${r.id} ${r.title}${r.required ? '' : ' (optional)'}`);
  } else lines.push(`- ${L.none}`);
  lines.push('', `## ${L.confirm}`, `- ${run.confirmation?.confirmedAt ?? '-'}: "${run.confirmation?.approvalText ?? ''}"`);
  const docExtra = run.docs?.extraApproved?.files ?? [];
  lines.push('', `## ${L.docs}`, ...((run.docs?.files ?? []).length ? run.docs.files.map((f) => `- ${f}`) : docExtra.length ? [] : [`- ${L.none}`]));
  if (docExtra.length) lines.push(...docExtra.map((f) => `- ${f} (${L.extra})`));
  if (values.AIWF_ORGANIZATION_NOTICE) lines.push('', '---', values.AIWF_ORGANIZATION_NOTICE);
  return `${lines.join('\n')}\n`;
}

export async function cmdDocsDone(ctx, opts) {
  const values = requireValidConfig(ctx);
  requireEnvIgnored(ctx);
  const summary = typeof opts.summary === 'string' ? opts.summary.trim() : '';
  if (summary.length < 2) throw usageError('--summary "<어떤 문서를 쓰거나 고쳤는지>" 가 필요하다.');
  const extraText = typeof opts['extra-approved'] === 'string' ? opts['extra-approved'].trim() : '';
  const noDocsText = typeof opts['no-docs-approved'] === 'string' ? opts['no-docs-approved'].trim() : '';
  if ((extraText || noDocsText) && opts['user-confirmed'] !== true) throw usageError('--extra-approved·--no-docs-approved 는 사용자 답변 원문이고 --user-confirmed 와 함께 쓴다.');
  return withLock(ctx, 'docs-done', async () => {
    const run = resolveRun(ctx, opts);
    if (run.phase !== 'DOCS') throw blocked('WRONG_PHASE', `문서 단계가 아니다 (현재 ${PHASE_LABELS[run.phase]}).`);
    const docsDir = values.AIWF_DOCS_DIR;
    const lines = [];
    let docFiles = [];
    if (run.docs?.baseline) {
      const changed = changedSinceBaseline(ctx, run.docs.baseline);
      const { inScope, outOfScope } = classifyChanges(changed, { allowedFiles: [docsDir], featureId: run.featureId, ignoreCase: ignoreCase(ctx) });
      if (outOfScope.length && !extraText) {
        throw blocked('OUT_OF_SCOPE', [
          `확정 이후 문서 폴더(${docsDir}/) 밖 파일이 바뀌었다:`,
          ...outOfScope.map((f) => `  - ${f}`),
          '확정한 코드가 바뀐 것이다. 되돌리거나, 사용자 허락을 받아 --extra-approved "<사용자 답변 원문>" --user-confirmed 로 다시 실행한다.',
        ].join('\n'), { decision: outOfScopeDecision(values.AIWF_DOC_LANGUAGE, { featureId: run.featureId, files: outOfScope, docs: true }) });
      }
      // 루트 README·CLAUDE.md 처럼 문서 폴더 밖 문서만 고친 경우도 사용자가 허락했으면 문서 작업으로 본다.
      if (inScope.length === 0 && outOfScope.length === 0 && !noDocsText) {
        throw blocked('DOCS_EMPTY', `바뀐 문서가 없다. ${docsDir}/ 아래(또는 사용자 허락을 받아 그 밖)에 문서를 쓰거나, 문서가 필요 없다는 사용자 답변을 --no-docs-approved 로 남긴다.`, { decision: docsEmptyDecision(values.AIWF_DOC_LANGUAGE, { featureId: run.featureId, docsDir }) });
      }
      docFiles = inScope;
      if (outOfScope.length) run.docs.extraApproved = { files: outOfScope, approvalText: redact(extraText).slice(0, 2000) };
    } else {
      lines.push('[주의] git 저장소가 아니라 바뀐 문서를 확인하지 않았다.');
    }
    if (noDocsText) run.docs.noDocsApproval = redact(noDocsText).slice(0, 2000);
    run.docs.files = docFiles;
    run.docs.summary = redact(summary).slice(0, 2000);
    run.docs.finishedAt = ctx.now();
    run.phase = 'DONE';
    const reportFile = path.join(featureDir(ctx, run.featureId), 'report.md');
    atomicWriteFile(reportFile, renderReport(ctx, run));
    saveRun(ctx, run);
    appendEvent(ctx, run, {
      type: 'RUN_DONE', status: 'DONE',
      summary: `기능 완료. 문서 ${docFiles.length}개: ${summary.slice(0, 300)}`,
      evidencePaths: [...docFiles, `.ai-workflow/features/${run.featureId}/report.md`],
      data: { docs: docFiles.length, firstDoc: docFiles[0] ?? null },
    });
    lines.unshift(`${run.featureId} 완료. 문서 ${docFiles.length}개${docFiles.length ? `: ${docFiles.join(', ')}` : ''}`);
    lines.push(`보고서: .ai-workflow/features/${run.featureId}/report.md`);
    if (!fs.existsSync(path.join(ctx.projectRoot, docsDir))) lines.push(`[주의] 문서 폴더 ${docsDir}/ 가 없다.`);
    return { ok: true, message: lines.join('\n') };
  });
}
