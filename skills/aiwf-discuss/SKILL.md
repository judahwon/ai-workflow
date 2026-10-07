---
name: aiwf-discuss
description: ai-workflow 논의·기획 단계. 새 기능을 시작하거나(new), 논의 단계(DISCUSS)인 기능의 요구사항을 사용자와 정리해 decisions.md·requirements.md 를 쓰고 기획 승인(approve --phase plan)까지 진행할 때 쓴다.
---

# 논의 → 기획 승인

목표: 사용자와 합의한 요구사항을 `requirements.md` 에 REQ 단위로 확정하고, 사용자 승인을 엔진에 기록한다.
이 단계에서는 **제품 코드를 고치지 않는다.**

## 1. 기능 시작

진행 중인 기능이 아니면 만든다.

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" new --title "<사용자가 말한 기능 이름>"
```

출력의 FEAT-### 와 문서 폴더(`.ai-workflow/features/FEAT-###/`)를 기억한다. 설정이 없다고 막히면 `aiwf-setup` 부터 한다.

## 2. 현재 상태 파악

질문하기 전에 관련 코드·문서를 먼저 읽어, 코드로 알 수 있는 것은 묻지 않는다.
여러 모듈에 걸쳐 찾을 것이 많으면 탐색용 서브에이전트에 맡긴다.

## 3. 논의

- 모호한 점은 **AskUserQuestion** 으로 묻는다. 한 번에 1~4개, 선택지에는 권장안을 첫 번째로 두고 "(권장)"을 붙인다.
- 정상·예외·빈 결과·오류 상태, 권한, 범위 밖 항목을 빠뜨리지 않는다.
- 답을 받으면 `decisions.md` 의 "사용자 결정"에 기록한다: `D-###` / 날짜 / 질문 / 사용자 답변(원문) / 영향 REQ.
- 사용자가 답하지 않은 제안은 "Claude 제안 (사용자 확인 대기)"에 두고, 확정된 것처럼 쓰지 않는다.
- 아직 답이 없는 질문은 `requirements.md` 의 "미결 질문"에 `- Q-###: ...` 로 적는다. 남아 있으면 승인이 막힌다.

## 4. requirements.md 작성

- `명세 버전:` 을 채운다 (예: v1.0). 내용을 바꿀 때마다 올린다.
- 요구사항마다 `- REQ-###: <검증 가능한 문장>` 으로 번호를 붙인다. 하나의 REQ 에는 하나의 확인 가능한 동작만 둔다.
- 완료 조건은 나중에 테스트로 확인할 수 있게 구체적으로 쓴다.

## 5. 기획 승인

1. 요구사항 요약(REQ 목록, 범위 밖, 결정 사항)을 사용자에게 보여준다.
2. **AskUserQuestion** 으로 진행 방식을 묻는다.
   - "자율 진행으로 맡긴다 (권장)": master 가 설계·개발·검수·검증을 혼자 하고, 막힐 때와 끝났을 때만 Slack 멘션으로 부른다.
   - "단계마다 같이 진행": 설계 승인·검수 판단·확정을 사용자와 함께 한다.
   - "아직 승인하지 않음": 논의를 이어간다.
3. 자율 진행을 고르면, 사용자가 떠나기 전에 사용자 몫인 준비를 끝낸다. 둘 다 사용자 승인이 필요하다.
   - **프로젝트 검사(checks.json)**: 없거나 승인이 풀렸으면 `aiwf-verify` 의 checks-set 절차로 정한다. http·browser 테스트가 필요할 서버 주소(origins)도 여기서 넣는다.
   - **허용 명령(autonomy.json)**: `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" autonomy-suggest` 의 후보를 AskUserQuestion(multiSelect)으로 보여주고,
     고른 접두사를 `{"allow": [...]}` JSON 파일(프로젝트 밖 임시 폴더)로 써서 저장한다.
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" autonomy-set --from <임시 JSON> --approval-text "<사용자 답변 원문>" --user-confirmed
     ```
     자리를 비운 동안 이 목록 밖의 명령은 권한 확인이 떠서 사용자를 부르게 된다고 알린다. 엔진 명령은 따로 넣지 않아도 된다.
   - Slack 알림이 꺼져 있으면 부를 방법이 없다고 알리고, 켤지 묻는다 (`aiwf-setup`).
4. 사용자가 고른 답변 **원문 그대로** 승인한다. 자율 진행이면 `--autonomous` 를 붙인다.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" approve --feature FEAT-### --phase plan --approval-text "<사용자 답변 원문>" --user-confirmed [--autonomous]
   ```
5. 막히면(`REQUIREMENTS_EMPTY`, `OPEN_QUESTIONS` 등) 메시지대로 문서를 고치고 다시 확인받는다.
6. 승인되면 자율 진행은 `aiwf-autopilot`, 함께 진행은 `aiwf-design` 으로 넘어간다.
   자율 진행이면 "이제 자리를 비우셔도 됩니다. 필요할 때 Slack 으로 부르겠습니다." 라고 알리고 바로 시작한다.

승인 뒤 `requirements.md` 를 고치면 기획·설계 승인이 모두 풀리고 이 단계로 돌아온다. 고칠 때는 사용자에게 먼저 알린다.
