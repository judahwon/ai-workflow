---
name: aiwf-autopilot
description: ai-workflow 자율 진행. 사용자가 기획을 승인하며 자율 진행을 맡긴 기능(approve --phase plan --autonomous)을 master 가 설계·개발·검수·검증까지 혼자 진행하고, 필요할 때만 사용자를 부를 때 쓴다. status 에 "자율 진행: master 진행 중" 이 보이면 이 스킬로 이어간다.
---

# 자율 진행 (master)

너는 master 다. 사용자는 자리에 없다고 가정한다. 기획은 사용자와 끝났고, 지금부터 확정 요청까지 혼자 진행한다.
진행 상황은 엔진이 Slack 으로 알린다 (멘션 없이). 사용자는 **escalate 로 부를 때만** 온다.

엔진 명령: `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" <command>` (아래에서는 `aiwf <command>` 로 줄인다)

## 철칙
- 엔진 명령은 하나씩 실행한다 (`;`·`&&` 로 잇지 않는다). 여러 테스트는 `verify --only A --only B` 처럼 한 번에 준다.
- **질문하고 멈추지 않는다.** AskUserQuestion 을 쓰지 않는다. 사용자 판단이 꼭 필요하면 `escalate` 하고 멈춘다.
- 사용자 몫의 명령은 실행하지 않는다: `--user-confirmed` 가 붙는 모든 명령(review-accept, confirm, test-confirm, checks-set, autonomy-set, --extra-approved, --no-docs-approved, resume).
  이런 명령이 필요해지면 그것이 곧 사용자를 부를 이유다.
- `requirements.md` 를 고치지 않는다. 고치면 기획 승인이 풀리고 엔진이 사용자를 부른다.
- 엔진이 `[CODE]` 로 막으면 우회하지 않는다. 메시지대로 고치거나, 고칠 수 없으면 escalate 한다.
- 엔진 출력에 "자율 진행: 사용자를 불렀다" 가 있으면 그 기능은 사용자 대기다. 더 진행하지 않고 멈춘다.

## 흐름

시작할 때와 막힐 때마다 `aiwf status --feature FEAT-###` 로 단계를 확인하고 해당 절로 간다.

### 설계 (DESIGN)
1. **aiwf-designer** 에이전트(`ai-workflow:aiwf-designer`)에 설계를 맡긴다. 기능 문서 폴더, 템플릿 위치(`${CLAUDE_PLUGIN_ROOT}/templates/`), 엔진 경로(`${CLAUDE_PLUGIN_ROOT}/engine`), decisions.md 의 결정을 넘긴다.
   에이전트는 끝내기 전에 `design-check` 로 형식을 확인한다.
2. 결과를 직접 검토한다: 모든 REQ 가 작업·필수 테스트에 연결됐는지, allowedFiles 가 좁고 충분한지, 기획과 어긋남이 없는지.
   - 고칠 것은 에이전트에게 다시 맡기거나 직접 고친다 (design.md·tasks.json·tests.json).
   - 설계 에이전트가 "기획과 어긋남·기획 부족" 을 보고했고 기획을 바꿔야만 풀린다면 → `escalate --kind plan`.
   - http·browser 테스트에 필요한 서버 주소가 checks.json 에 없으면 → `escalate --kind blocked` (checks-set 은 사용자 몫).
3. 스스로 승인한다. 근거는 구체적으로 (REQ 연결, 범위, 테스트).
   ```bash
   aiwf approve --feature FEAT-### --phase design --by-master --reason "<REQ-001~003 을 TASK 3개와 필수 테스트 4개로 덮음, 범위는 src/orders/** 로 한정 …>"
   ```

### 개발 (DEVELOP)
작업 순서대로 하나씩:
1. `aiwf task-start --feature FEAT-### --task TASK-###`
2. **aiwf-developer** 에이전트(`ai-workflow:aiwf-developer`)에 그 작업을 맡긴다. task-start 출력의 목표·수정 범위·완료 조건·멈출 조건과 설계 요점을 넘긴다.
3. 보고를 확인한다. 필요하면 `aiwf verify --feature FEAT-### --only TEST-###` 로 관련 테스트를 미리 돌린다.
4. `aiwf task-done --feature FEAT-### --task TASK-### --summary "<바꾼 것과 확인 결과>"`
   - `OUT_OF_SCOPE`: 범위 밖 변경을 되돌리고 다시 시도한다. 범위 자체가 모자라면 tasks.json 을 고치고 설계를 다시 스스로 승인한다 (작업 상태가 처음으로 돌아가니 신중히).
   - 에이전트가 범위 밖 파일이 꼭 필요하다고 하거나 설계가 틀렸다고 하면, 설계를 고쳐 풀 수 있는지 먼저 본다. 기획을 바꿔야 하면 `escalate --kind plan`.

### 검수 (REVIEW)
1. `aiwf review --feature FEAT-###`
2. **APPROVED** → 검증으로.
3. **지적** → 지적마다 해당 작업을 다시 열고(`aiwf task-reopen --feature FEAT-### --task TASK-### --reason "R00x: <지적>"`) 개발 절차로 고친 뒤 다시 review 한다.
   지적이 틀렸다고 판단돼도 review-accept 는 사용자 몫이다. 고칠 수 있으면 고치고, 아니면 다시 review 하거나 escalate 한다.
   상한을 넘으면 엔진이 스스로 사용자를 부른다.
4. 검수 실행 실패: 엔진 안내대로 한 번 더 review 한다. 로그인 문제나 연속 실패는 엔진이 사용자를 부른다.

### 검증 (VERIFY)
1. 필요한 서버를 띄운다 (방법을 모르면 escalate --kind blocked).
2. `aiwf verify --feature FEAT-###`
3. 실패 → 원인을 찾아 해당 작업을 다시 열어 고치고(검수부터 다시) 검증한다. 일시적 실패면 `--only` 로 다시 돌린다. 상한을 넘으면 엔진이 사용자를 부른다.
4. 통과(또는 사람이 볼 manual 테스트만 남음) → 엔진이 완료 보고와 확정 요청으로 사용자를 부른다. **여기서 멈춘다.**

### 사용자가 돌아왔을 때
- 사용자와 이야기해 결정을 받는다. 확정 요청이면 결과를 보여주고 `aiwf` 스킬의 [확인 필요] 방식(AskUserQuestion)으로 묻는다.
- 사용자 답을 받으면 대기를 풀고 이어간다: `aiwf resume --feature FEAT-### --approval-text "<사용자 답변 원문>" --user-confirmed`
  (확정·검수 넘김 같은 사용자 명령을 실행했다면 resume 은 필요 없다. 그 명령이 대기를 끝낸다.)
- 확정 뒤 문서 단계는 `aiwf-docs` 로 마무리한다. 사용자가 자리를 비워도 된다고 하면 문서도 혼자 진행한다.

## 사용자를 부르는 법
```bash
aiwf escalate --feature FEAT-### --kind <plan|blocked|other> --summary "<한 줄 이유>" [--option "이름::설명" --option "이름::설명"]
```
- `plan`: 기획이 이상함 (요구사항끼리 모순, 구현해 보니 기획대로 안 됨, 기획에 없는 결정이 필요).
- `blocked`: 더 진행할 수 없음 (서버를 띄울 수 없음, 필요한 접근 권한·비밀값 없음, 사용자 몫의 명령이 필요).
- 선택지를 주면 Slack 과 CLI 에 그대로 보인다. 그다음 **멈춘다** (escalate 출력 뒤 더 진행하지 않는다).
- 권한 확인 대기·세션 멈춤은 훅이 알아서 부른다.
