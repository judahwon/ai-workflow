---
name: aiwf
description: ai-workflow 로 기능을 진행할 때 시작점. 사용자가 새 기능 개발·기능 논의·"워크플로로 진행"을 요청하거나, 진행 중인 기능(FEAT-###)을 이어 갈 때 쓴다. 현재 단계를 확인하고 단계별 스킬(aiwf-setup, aiwf-discuss, aiwf-design, aiwf-develop, aiwf-review, aiwf-verify, aiwf-docs)로 넘긴다.
---

# ai-workflow 시작점

이 프로젝트는 `.ai-workflow/` 엔진으로 기능을 **논의 → 기획 → 설계 → 개발 → 검수 → 확정 → 문서** 순서로 진행한다.
진행(대화·문서 작성·구현)은 이 세션이 하고, 엔진은 관문(승인·범위·상태 기록)만 맡는다.

명령은 프로젝트 루트에서 실행한다: `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" <command>`
프로젝트 데이터(기능 문서·설정·실행 기록)는 프로젝트의 `.ai-workflow/` 에 있다. 아직 없으면 `aiwf-setup` 이 만든다.

## 먼저 할 일

1. `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" status` 를 실행해 설정 상태와 진행 중인 기능을 본다.
2. 결과에 따라 해당 스킬로 넘어간다.

| status 결과 | 다음 |
|---|---|
| 설정 없음·오류, git 제외 문제 | `aiwf-setup` |
| 사용자가 새 기능을 말함 | `aiwf-discuss` (`new` 부터) |
| 단계: 논의·기획 | `aiwf-discuss` |
| 단계: 설계 | `aiwf-design` |
| 단계: 개발 | `aiwf-develop` |
| 단계: 검수 | `aiwf-review` |
| 단계: 확정 (테스트·완료 판정) | `aiwf-verify` |
| 단계: 문서 작성 | `aiwf-docs` |
| 단계: 완료 | 결과(report.md)를 알리고 다음 기능을 묻는다 |
| `! 승인 이후 변경` 표시 | 바뀐 문서를 사용자에게 보여주고, 해당 단계 스킬에서 다시 승인받는다 |

## [확인 필요] 블록 — 객관식으로 묻는다

엔진 출력에 `[확인 필요] <질문>` 블록이 있으면 사용자가 골라야 하는 순간이다 (검수 지적, 검증 실패, 확정 대기, 승인 풀림, 범위 밖 변경, 문서 없음).
같은 내용이 Slack 에 "🟠 확인 필요" 로 가므로, 사용자는 Claude Code 에서 고르기를 기대한다.

1. 블록 내용을 사용자에게 짧게 보여준다 (왜 멈췄는지, 관련 지적·실패·파일).
2. **AskUserQuestion** 으로 묻는다. 질문은 블록의 질문, `header` 는 `머리말:` 값, 선택지는 번호 순서 그대로, 각 선택지의 설명은 `—` 뒤 문장이다.
   선택지를 더하거나 빼지 않는다 (사용자는 Other 로 직접 답할 수 있다).
3. 고른 선택지의 `→` 명령을 실행한다. `<TASK-###>`, `<지적 요약>` 같은 자리는 맥락으로 채우고, 모르면 사용자에게 묻는다.
   - `[승인]` 표시가 있는 선택지는 고른 것이 승인이다. `--approval-text` 에 사용자가 고른 선택지 이름(덧붙인 메모가 있으면 함께)을 **그대로** 넣는다.
   - Other 로 자유롭게 답했으면 그 답이 어느 선택지인지 분명할 때만 실행하고, 애매하면 다시 묻는다.
4. 결과 출력에 또 `[확인 필요]` 가 있으면 같은 방식으로 이어서 묻는다.

## 항상 지키는 것

- **승인은 사용자만 한다.** `approve`, `checks-set`, `review-accept`, `test-confirm`, `confirm`, `--extra-approved`, `--no-docs-approved` 는 사용자가 이 대화에서 진행을 명시적으로 말한 뒤에만 실행하고,
  `--approval-text` 에는 사용자 답변을 **고치지 않고 그대로** 넣는다. 사용자가 답하지 않은 질문을 승인으로 간주하지 않는다.
- `.ai-workflow/engine/`, `runs/`, `state/`, `project.env`, `.env`, `~/.ai-workflow/user.env` 를 직접 고치지 않는다. 상태·설정은 엔진 명령으로만 바꾼다.
- 엔진이 `[CODE]` 로 막으면 우회하지 않는다. 메시지대로 문서를 고치거나 사용자에게 묻는다.
  - `[ENGINE_OUTDATED]`: 팀의 다른 사람이 더 새 버전으로 이 프로젝트를 다뤘다. 사용자에게 `/plugin` 에서 ai-workflow 를 업데이트하고 Claude Code 를 다시 열라고 알린다.
  - `[PROJECT_ENGINE_PRESENT]`: 이 프로젝트에는 엔진이 직접 설치돼 있다. 메시지의 `node .ai-workflow/engine/cli.mjs` 로 실행할지, `.ai-workflow/engine/` 을 지우고 플러그인으로 옮길지 사용자에게 묻는다.
- 종료 코드: 0 성공, 1 오류, 2 사용법, 3 차단, 4 잠금. 잠금(4)은 다른 명령이 도는 중이다. 오래된 잠금이면 사용자에게 알린다.
- 토큰·비밀번호를 문서·`.env`·명령 인자에 넣지 않는다.
- Slack 알림이 켜져 있으면 엔진이 단계 전환마다 자동으로 보낸다. 출력의 "Slack 알림: 실패" 는 사용자에게 알리고 `notify` 로 다시 보낸다.
