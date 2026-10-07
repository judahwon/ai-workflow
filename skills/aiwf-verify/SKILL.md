---
name: aiwf-verify
description: ai-workflow 확정 단계(VERIFY). 프로젝트 검사(checks.json)와 기능 테스트(tests.json)를 verify 로 실행하고, manual 테스트를 사용자에게 확인받아 confirm 으로 확정할 때 쓴다. checks.json 등록·변경(checks-set)에도 쓴다.
---

# 검증 → 확정

## 프로젝트 검사 (checks.json) — 처음 한 번, 또는 바뀔 때

`.ai-workflow/checks.json` 은 매번 돌리는 린트·빌드·테스트 명령과 서버 주소(origins)다. 커밋 대상이고, **사용자 승인으로만 바꾼다.**
파일을 직접 고치지 않는다 (훅이 막고, 고쳐도 승인이 풀려 검증이 막힌다).

1. 프로젝트의 package.json·빌드 도구·CI 설정을 읽고 후보를 만든다. 형식은 `.ai-workflow/templates/checks.example.json`.
   - `checks[]`: `id`(영소문자), `title`, `command`, 선택 `cwd`(루트 기준), `timeoutSec`, `required`
   - `origins`: http·browser 테스트가 쓰는 서버 주소 이름 (예: `app`, `api`)
2. 후보를 사용자에게 보여주고 확인받는다. 프로젝트 밖(임시 폴더)에 JSON 파일로 쓴 뒤 저장한다.
   ```bash
   node .ai-workflow/engine/cli.mjs checks-set --from <임시 JSON 경로> --approval-text "<사용자 답변 원문>" --user-confirmed
   ```
   사용자가 파일을 직접 고쳤다면 `--from` 없이 실행해 현재 내용을 승인한다.

## 검증

1. 필요한 서버(http·browser 테스트의 origins)가 떠 있는지 확인한다. 띄우는 방법을 모르면 사용자에게 묻는다.
   browser 테스트는 Playwright 가 필요하다 (`.env` 의 `AIWF_PLAYWRIGHT_MODULE` 또는 프로젝트 node_modules).
   비밀값이 필요한 테스트는 `AIWF_TEST_*` 환경변수로 받는다. 값을 대화나 파일에 쓰지 않고, 사용자에게 환경변수 설정을 부탁한다.
2. 실행한다.
   ```bash
   node .ai-workflow/engine/cli.mjs verify --feature FEAT-###
   node .ai-workflow/engine/cli.mjs verify --feature FEAT-### --only TEST-002   # 일부만 다시 (확정에는 전체 필요)
   ```
3. 결과를 사용자에게 그대로 보고한다 (통과·실패·실행 불가 건수, 실패 메시지, 로그 경로). 실패를 통과로 말하지 않는다.
   - **FAIL**: 원인을 로그로 확인한다. 코드 문제면 `task-reopen` → `aiwf-develop` 으로 고친다 (검수부터 다시).
     테스트 정의가 틀렸으면 `tests.json` 을 고치고 설계를 다시 승인받는다.
   - **BLOCKED**: 서버 미기동·Playwright 없음·환경변수 없음 등. 해결해 다시 실행한다.
   - **MANUAL**: 사람이 확인할 테스트다. 절차와 기대 결과를 사용자에게 보여주고 직접 확인을 부탁한다.
     사용자가 통과라고 답하면 원문 그대로 기록하고 `verify` 를 다시 실행한다.
     ```bash
     node .ai-workflow/engine/cli.mjs test-confirm --feature FEAT-### --test TEST-### --approval-text "<사용자 답변 원문>" --user-confirmed
     ```

## 확정

1. 필수 항목이 모두 PASS 인 전체 검증 결과와 검수 결과를 요약해 사용자에게 보여주고 확정할지 묻는다.
2. 사용자가 확정을 명시적으로 말하면 원문 그대로 기록한다.
   ```bash
   node .ai-workflow/engine/cli.mjs confirm --feature FEAT-### --approval-text "<사용자 답변 원문>" --user-confirmed
   ```
3. `NOT_READY` 면 나열된 이유를 해결한다. 검수·검증 이후 코드가 바뀌었으면 다시 검수(또는 사용자 허락으로 review-accept)·검증한다.
4. 확정되면 `aiwf-docs` 로 간다.
