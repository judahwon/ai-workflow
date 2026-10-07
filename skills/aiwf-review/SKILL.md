---
name: aiwf-review
description: ai-workflow 검수 단계(REVIEW). 모든 작업이 끝난 기능을 Codex 로 독립 검수(review)하고, 지적을 사용자와 정리해 작업을 다시 열거나(task-reopen) 넘길 때(review-accept) 쓴다.
---

# 검수

구현한 이 세션이 아니라 **다른 모델(Codex CLI, 읽기 전용)** 이 요구사항·설계 대비 변경을 검토한다.
이 세션은 검수 결과를 고치거나 해석을 바꾸지 않고, 사용자에게 그대로 전한다.

## 순서

1. 검수를 실행한다. 수 분이 걸릴 수 있다.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" review --feature FEAT-###
   ```
2. 결과를 사용자에게 보여준다: 판정, 요구사항별 MET/NOT_MET/UNVERIFIED, 지적(심각도·파일·내용).
   요청 모델(`AIWF_REVIEW_MODEL`)은 기록되지만 실제로 응답한 모델은 확인할 수 없다는 점도 알린다.
3. 판정에 따라:
   - **APPROVED** → 엔진이 확정(검증) 단계로 옮긴다. `aiwf-verify` 로 간다.
   - **CHANGES_REQUESTED** → 지적마다 고칠지 사용자와 정한다 (AskUserQuestion, 권장안 먼저).
     - 고친다 → 해당 작업을 다시 연다. 이유에 검수 번호와 지적을 적는다.
       ```bash
       node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" task-reopen --feature FEAT-### --task TASK-### --reason "R001: <지적 요약>"
       ```
       그다음 `aiwf-develop` 으로 고치고, 모든 작업이 끝나면 다시 `review` 한다.
     - 고칠 필요가 없다(오탐·범위 밖) → 사용자의 답변 **원문 그대로** 넘긴다.
       ```bash
       node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" review-accept --feature FEAT-### --approval-text "<사용자 답변 원문>" --user-confirmed
       ```
     - 요구사항·설계 자체가 틀렸다 → 문서를 고치고 `aiwf-discuss`·`aiwf-design` 에서 다시 승인받는다.

## 검수가 실행되지 않을 때

- `CODEX_NOT_FOUND`: `.ai-workflow/.env` 의 `AIWF_CODEX_BIN` 을 확인한다 (`aiwf-setup`).
- `AUTH_NOT_CHATGPT`: codex 가 ChatGPT 로그인이 아니다 (API 키 로그인이거나 미로그인). 사용자에게 `codex login` 에서 ChatGPT 로 로그인하도록 부탁한다.
  API 키 과금을 감수하겠다고 사용자가 말한 경우에만 `.env` 의 `AIWF_REVIEW_AUTH` 를 `any` 로 바꾼다 (`aiwf-setup`).
- `CODEX_ERROR`: 사용량 제한·네트워크 문제일 수 있다. 사용자에게 알린다.
- `REVIEW_NOT_JSON` 등 형식 오류: 다시 `review` 한다. 계속되면 사용자에게 알린다.
- Codex 없이 진행할지는 **사용자가 정한다.** 허락하면 `review-accept` 로 넘기고, 이 세션이 대신 검수했다고 말하지 않는다.

## 주의

- 검수 이후 코드를 고치면 검수 결과가 무효가 된다 (확정할 때 다시 검수 또는 review-accept 가 필요하다).
- 지적을 고칠 때는 반드시 `task-reopen` → `task-start` 로 작업 범위 안에서 고친다. 검수 단계에서 바로 코드를 고치지 않는다.
