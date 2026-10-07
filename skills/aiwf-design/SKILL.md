---
name: aiwf-design
description: ai-workflow 설계 단계(DESIGN). 기획 승인된 요구사항으로 design.md, 작업 계약 tasks.json, 기능 테스트 tests.json 을 쓰고 설계 승인(approve --phase design)까지 진행할 때 쓴다.
---

# 설계 → 설계 승인

목표: 승인된 REQ 를 구현할 방법과 작업 단위(수정 허용 범위 포함)를 정하고 사용자 승인을 받는다.
이 단계에서도 **제품 코드를 고치지 않는다.**

## 1. 현재 구조 파악

`requirements.md` 의 REQ 마다 관련 파일·호출 흐름·데이터 흐름을 코드에서 확인하고, `design.md` "현재 구조 파악"에 파일 경로를 근거로 적는다.
프로젝트의 CLAUDE.md·컨벤션 문서가 있으면 따른다.

## 2. design.md

- `설계 버전:` 과 `기준 명세 버전:`(기획 승인된 버전)을 채운다.
- 변경 설계, 검토한 대안, 영향 범위와 위험, REQ 별 테스트 전략을 쓴다.
- 사용자 결정이 필요한 것은 AskUserQuestion 으로 묻고, 답이 오기 전까지 "미결 질문"에 `- Q-###` 로 둔다.

## 3. tasks.json — 작업 계약

형식은 `${CLAUDE_PLUGIN_ROOT}/templates/tasks.example.json` 을 따른다.

| 필드 | 규칙 |
|---|---|
| `id` | `TASK-###` |
| `title`, `goal` | 무엇을 왜 하는지 |
| `requirementIds` | 이 작업이 구현하는 REQ. **모든 REQ 가 어떤 작업엔가 연결돼야 한다** |
| `allowedFiles` | 수정 허용 범위. 프로젝트 루트 기준 `/` 경로 또는 glob(`*`, `**`, `?`). glob 이 없는 경로는 그 파일 또는 그 폴더 전체 |
| `completionCriteria` | 완료를 확인할 수 있는 문장 |
| `dependsOn` | 먼저 끝나야 하는 작업 (선택) |
| `stopConditions` | 멈추고 사용자에게 보고할 조건 (선택) |

- `allowedFiles` 는 필요한 만큼만 좁게 잡는다. 새로 만들 파일·테스트 파일도 포함한다.
  `.git/`, `.ai-workflow/`, `node_modules/`, `.env*`, 프로젝트 전체(`**`)는 엔진이 거부한다.
- 개발 중에는 이 범위 밖 수정을 훅이 막고, 완료 시 git 으로 다시 확인한다. 범위가 모자라면 설계를 다시 승인받아야 하므로 처음에 꼼꼼히 정한다.
- 작업 하나는 한 번에 검토할 수 있는 크기로 나눈다 (최대 50개).

## 4. tests.json — 기능 테스트

요구사항이 충족됐는지 확정 단계에서 확인할 테스트다. 형식은 `${CLAUDE_PLUGIN_ROOT}/templates/tests.example.json`.
**모든 REQ 에 필수(`required` 기본 true) 테스트가 1개 이상** 있어야 승인된다.

| kind | 내용 |
|---|---|
| `command` | 셸 명령 (`command`, 선택 `cwd`). 종료 코드 0 이면 통과. 단위·통합 테스트 |
| `http` | `request`(`origin` 이름, `method`, `path`, `headers`, `body`) → `expect`(`status`, `contentType`, `bodyContains`, `json` 경로 값) |
| `browser` | `origin` + 선언형 `steps`(goto·fill·click·press·selectOption·check·expectVisible·expectHidden·expectText·expectURL·expectCount). 첫 단계는 goto |
| `manual` | 사람이 따라 할 `steps` 와 `expected`. 확정 단계에서 사용자가 확인한다 |

- http·browser 의 `origin` 은 `.ai-workflow/checks.json` 의 `origins` 이름이다. 없으면 `aiwf-verify` 의 checks-set 으로 먼저 등록한다.
- 비밀값(토큰·비밀번호)은 직접 쓰지 않는다. 헤더는 `{ "fromEnv": "AIWF_TEST_..." }`, 입력은 `valueFromEnv` 로 받는다.
- 린트·빌드처럼 매번 도는 것은 tests.json 이 아니라 checks.json 에 둔다.
- 자동으로 확인할 수 있는 것은 manual 로 두지 않는다.

## 5. 설계 승인

1. 설계 요약, 작업 표(ID, 제목, REQ, 수정 허용 범위, 순서), 테스트 표(ID, 종류, REQ)를 사용자에게 보여주고 진행해도 되는지 묻는다.
2. 사용자가 진행을 명시적으로 말하면 답변 **원문 그대로** 승인한다.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" approve --feature FEAT-### --phase design --approval-text "<사용자 답변 원문>" --user-confirmed
   ```
3. `TASK_INVALID`, `REQUIREMENTS_UNCOVERED`, `TESTS_INVALID`, `REQUIREMENTS_UNTESTED` 등으로 막히면 고치고 바뀐 점을 사용자에게 알린 뒤 다시 확인받는다.
4. 승인되면 `aiwf-develop` 으로 넘어간다.

승인 뒤 `design.md`·`tasks.json`·`tests.json` 을 고치면 설계 승인이 풀리고, 다시 승인하면 모든 작업이 대기 상태로 돌아간다.
