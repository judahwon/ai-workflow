---
name: aiwf-docs
description: ai-workflow 문서 단계(DOCS). 확정된 기능을 프로젝트 문서 폴더(AIWF_DOCS_DIR)에 정리하고 docs-done 으로 기능을 완료할 때 쓴다.
---

# 문서 → 완료

확정된 기능의 내용을 사람이 읽을 문서로 남긴다. 이 단계에서는 **문서 폴더 밖 파일(코드)을 고치지 않는다.**
확정 이후 코드가 바뀌면 `docs-done` 이 막는다.

## 순서

1. 문서 폴더를 확인한다: `.ai-workflow/.env` 의 `AIWF_DOCS_DIR` (기본 `docs`). `status` 출력이나 사용자에게 확인한다.
2. 기존 문서 구조와 규칙(프로젝트 CLAUDE.md·README·문서 컨벤션)을 먼저 읽는다. 새 파일을 만들지, 기존 문서를 고칠지 정한다.
   - 기능 설명(목적·사용법·화면/API 동작), 바뀐 설정·데이터 구조, 운영상 주의점을 담는다.
   - 근거는 `.ai-workflow/features/FEAT-###/` 의 requirements·design·decisions 와 실제 코드다. 확정되지 않은 내용은 쓰지 않는다.
   - 문서 언어는 `AIWF_DOC_LANGUAGE` 를 따른다. `AIWF_ORGANIZATION_NOTICE` 가 있으면 프로젝트 관례에 맞게 넣는다.
3. 어떤 문서를 쓰거나 고칠지 사용자에게 짧게 알리고 작성한다. 사용자가 원하면 초안을 먼저 보여준다.
4. 끝낸다.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" docs-done --feature FEAT-### --summary "<쓴·고친 문서와 내용>"
   ```
   - `DOCS_EMPTY`: 문서가 없다. 문서가 필요 없다고 사용자가 말한 경우에만 그 답변 원문으로 넘긴다.
     `--no-docs-approved "<사용자 답변 원문>" --user-confirmed`
   - `OUT_OF_SCOPE`: 확정 이후 문서 폴더 밖 파일이 바뀌었다. 되돌리거나, 사용자 허락을 받아
     `--extra-approved "<사용자 답변 원문>" --user-confirmed` 로 넘긴다. 코드 수정이 필요했다면 그 사실을 분명히 알린다.
     루트 README·CLAUDE.md 처럼 문서 폴더 밖 문서만 고치는 것도 같은 방법으로 넘기고, 보고서에 허락받은 문서로 남는다.
5. 완료되면 엔진이 `.ai-workflow/features/FEAT-###/report.md` (승인·작업·검수·검증·확정·문서 요약)를 만든다.
   결과를 사용자에게 요약하고, 커밋은 프로젝트 규칙에 따라 사용자 확인 후에 한다.
