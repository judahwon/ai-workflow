---
name: aiwf-develop
description: ai-workflow 개발 단계(DEVELOP). 설계 승인된 작업(TASK-###)을 순서대로 task-start → 구현 → 확인 → task-done 으로 진행할 때 쓴다. 작업의 수정 허용 범위(allowedFiles) 밖은 고치지 않는다.
---

# 개발

설계 승인된 작업을 의존 순서대로 하나씩 진행한다. 진행 중인 작업은 항상 하나다.

## 작업 하나의 흐름

1. `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" status --feature FEAT-###` 로 작업 순서와 상태를 본다. 대기(PENDING) 중 의존이 끝난 첫 작업을 고른다.
2. 시작한다.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" task-start --feature FEAT-### --task TASK-###
   ```
   출력의 목표·수정 허용 범위·완료 조건·멈출 조건을 사용자에게 짧게 알린다.
3. 구현한다.
   - **수정 허용 범위 안의 파일만 고친다.** 파일 수정 도구는 훅이 범위 밖을 거부한다.
     셸 명령(sed, 리다이렉션, 코드 생성기 등)으로 범위 밖 파일을 바꾸지 않는다. 완료 시 git 으로 다시 확인한다.
   - 프로젝트의 CLAUDE.md·컨벤션을 따른다. 요청하지 않은 리팩토링을 하지 않는다.
   - 기능 문서(`.ai-workflow/features/FEAT-###/`)는 고칠 수 있지만, 요구사항·설계·작업 목록이 바뀌면 승인이 풀린다.
4. 완료 조건을 확인한다. 프로젝트의 빌드·린트·테스트 명령이 있으면 실행하고 결과(통과/실패 건수)를 기록한다.
   실패를 성공으로 보고하지 않는다.
5. 끝낸다.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" task-done --feature FEAT-### --task TASK-### --summary "<무엇을 바꿨고 완료 조건을 어떻게 확인했는지>"
   ```
6. 다음 작업으로 간다. 모든 작업이 끝나면 엔진이 검수 단계로 옮긴다. 사용자에게 결과를 요약해 알리고 `aiwf-review` 로 간다.
   작업 중에 `verify --feature FEAT-### --only TEST-###` 로 테스트를 미리 돌려 봐도 된다 (확정에는 확정 단계의 전체 검증이 필요하다).

## 범위 밖 수정이 필요할 때

- 훅이 거부했거나, 범위 밖 파일을 바꿔야 한다는 것을 알게 되면 **멈추고 사용자에게 알린다.** 이유와 필요한 파일을 말한다.
- 선택지:
  - 범위가 잘못 잡혔다 → `tasks.json` 을 고치고 `aiwf-design` 으로 설계를 다시 승인받는다 (작업 상태가 처음으로 돌아간다).
  - 이번 한 번만 허락 → 사용자가 허락하면 `task-pause` 로 제한을 풀고 고친 뒤 `task-start` 로 재개한다.
    `task-done` 이 범위 밖 파일로 막히면(`OUT_OF_SCOPE`) 파일 목록을 보여주고, 사용자가 허락한 답변 **원문 그대로** 붙인다.
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" task-done --feature FEAT-### --task TASK-### --summary "..." --extra-approved "<사용자 답변 원문>" --user-confirmed
    ```
- 사용자 작업이 섞여 범위 밖 파일이 잡혔다면(사용자가 직접 고친 파일 등) 그 사실을 알리고 같은 방식으로 허락받는다. 사용자의 파일을 임의로 되돌리지 않는다.

## 멈출 때

- 작업의 멈출 조건에 걸리거나, 요구사항·설계가 틀렸다고 판단되면 멈추고 보고한다.
- 세션을 끝내거나 다른 일을 해야 하면 `task-pause` 로 제한을 푼다. 이어서 할 때 `task-start` 로 재개한다 (시작 기준은 유지된다).
- 커밋·푸시는 프로젝트 규칙을 따른다. 규칙이 없으면 하기 전에 사용자에게 확인받는다.
