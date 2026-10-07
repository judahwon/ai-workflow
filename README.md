# ai-workflow

Claude Code 와 함께 기능을 **논의 → 기획 → 설계 → 개발 → 검수 → 확정 → 문서** 순서로 진행하는 프로젝트 무관 워크플로 엔진.

- 진행(논의·문서 작성·구현)은 Claude Code 세션이 한다.
- 엔진은 관문만 맡는다: 사용자 승인을 문서 해시에 묶고, 문서가 바뀌면 승인을 되돌리고, 상태·이벤트를 기록한다.
- 의존성 없는 Node.js(20 이상) ESM. npm 설치가 필요 없다.

## 설치

```bash
node install.mjs <프로젝트 루트>            # 처음 설치
node install.mjs <프로젝트 루트> --upgrade  # 엔진·스킬만 교체 (.env·features·고친 템플릿 보존)
node install.mjs <프로젝트 루트> --no-claude # .claude/ (스킬·훅)는 건드리지 않음
```

프로젝트 린터(eslint·prettier·biome)가 `.ai-workflow/` 를 검사하면 엔진 파일 때문에 lint 검사가 실패한다.
설치가 이를 알리면 린터 제외 목록에 `.ai-workflow/` 를 넣는다.

프로젝트에 생기는 것:

```
.ai-workflow/
  engine/          엔진 (설치·업그레이드 때 교체)
  templates/ko|en/ 기능 문서 템플릿 (프로젝트에서 고쳐 써도 업그레이드가 덮어쓰지 않음)
  features/        기능별 문서(요구사항·설계·작업·테스트·보고서) — 커밋 대상
  checks.json      프로젝트 검사 명령·서버 주소 (사용자 승인으로만 변경) — 커밋 대상
  .env             프로젝트·개인·이 PC 설정 — git 제외
  .env.example     설정 키 설명 — 커밋 대상
  .gitignore       .env, runs/, state/ 제외
  runs/  state/    실행 상태·이벤트·잠금 — git 제외
  VERSION
.claude/
  skills/aiwf*/    단계별 Claude Code 스킬 8개 (설치·업그레이드 때 교체)
  settings.json    파일 수정 범위 훅 등록 (기존 설정은 유지, 한 번만 추가)
```

Claude Code 는 **프로젝트 루트에서** 연다. 훅과 스킬이 루트의 `.claude/` 에서 로드된다.

## 설정: `.ai-workflow/.env`

프로젝트 이름, 회사 문구, Slack ID, PC 경로를 모두 이 파일 하나에 둔다. 엔진과 템플릿에는 이런 값을 넣지 않는다.

```bash
node .ai-workflow/engine/cli.mjs init                        # 터미널에서 질의
node .ai-workflow/engine/cli.mjs init --set KEY=VALUE ...    # 비대화형 (Claude Code 가 사용자에게 물은 뒤 사용)
node .ai-workflow/engine/cli.mjs questions                   # 채울 항목 목록 (JSON, 값 미출력)
```

- 처음에는 모든 항목을, 이후에는 빠지거나 잘못된 항목만 묻는다 (`--all` 이면 전부).
- 토큰·비밀번호 형태의 값은 어떤 키에도 저장하지 않는다. Slack 토큰은 암호화된 파일의 **경로**만 둔다.
- git 저장소에서 `.ai-workflow/.env` 가 추적되거나 제외되지 않으면 작업 명령(`new`, `approve`)을 막는다.

| 구분 | 키 | 필수 |
|---|---|---|
| 프로젝트 | `AIWF_PROJECT_NAME` | ✔ |
| | `AIWF_PROJECT_SUMMARY`, `AIWF_ORGANIZATION`, `AIWF_ORGANIZATION_NOTICE` | |
| | `AIWF_DOC_LANGUAGE` (ko/en, 기본 ko), `AIWF_DOCS_DIR` (기본 docs) | ✔ (기본값) |
| 이 PC | `AIWF_CLAUDE_BIN`, `AIWF_CODEX_BIN`, `AIWF_REVIEW_MODEL`, `AIWF_REVIEW_AUTH` (chatgpt/any, 기본 chatgpt) | ✔ (기본값) |
| | `AIWF_PLAYWRIGHT_MODULE`, `AIWF_BROWSER_CHANNEL` | |
| 알림 | `AIWF_SLACK_ENABLED` (기본 false) | ✔ (기본값) |
| | `AIWF_SLACK_WORKSPACE`, `AIWF_SLACK_USER_ID`, `AIWF_SLACK_CHANNEL_ID`, `AIWF_SLACK_TOKEN_FILE` | Slack 사용 시 |

## 기능 진행

```bash
node .ai-workflow/engine/cli.mjs new --title "주문 목록 상태 필터"
node .ai-workflow/engine/cli.mjs approve --feature FEAT-001 --phase plan   --approval-text "<사용자 답변 원문>" --user-confirmed
node .ai-workflow/engine/cli.mjs approve --feature FEAT-001 --phase design --approval-text "<사용자 답변 원문>" --user-confirmed
node .ai-workflow/engine/cli.mjs status
```

| 단계 | 문서 | 관문 |
|---|---|---|
| 논의·기획 | `decisions.md`, `requirements.md` | `approve --phase plan`: 명세 버전, REQ-### 1개 이상, 미결 질문(Q-###) 없음 |
| 설계 | `design.md`, `tasks.json`, `tests.json` | `approve --phase design`: 설계 버전, 미결 질문 없음, 작업 계약 유효, 모든 REQ 가 작업·필수 테스트에 연결, 의존 순환 없음 |
| 개발 | 작업별 구현 | `task-start` → 구현 → `task-done`: 의존 작업 완료, 수정 허용 범위 안 변경만 (git 으로 확인) |
| 검수 | Codex 검수 결과 | `review`: 읽기 전용 Codex 가 승인(APPROVED)해야 다음 단계. 지적은 `task-reopen` 으로 고치거나 사용자 허락으로 `review-accept` |
| 확정 | 검증 결과 | `verify` → `confirm`: 전체 검증의 필수 항목 PASS, 검수·검증 이후 코드 변경 없음, 사용자 확정 |
| 문서 | `AIWF_DOCS_DIR` 아래 문서, `report.md` | `docs-done`: 확정 이후 문서 폴더 밖 변경 없음, 문서 1개 이상 → 완료 |

- 승인 뒤 `requirements.md` 가 바뀌면 기획·설계 승인을 모두 되돌리고 논의 단계로 간다.
- `design.md`, `tasks.json`, `tests.json` 이 바뀌면 설계 승인만 되돌린다. 이력은 `run.json` 의 `approvalHistory` 에 남는다.
- 작업의 `allowedFiles` 는 프로젝트 루트 기준 경로·glob(`*`, `**`)이다. `.git/`, `.ai-workflow/`, `node_modules/`, `.env*`, 프로젝트 전체(`**`)는 허용하지 않는다. 형식은 `templates/tasks.example.json`.

## 개발 단계와 수정 범위

```bash
node .ai-workflow/engine/cli.mjs task-start --feature FEAT-001 --task TASK-001
node .ai-workflow/engine/cli.mjs task-done  --feature FEAT-001 --task TASK-001 --summary "<변경·확인 내용>"
node .ai-workflow/engine/cli.mjs task-pause                       # 진행 중 작업 일시 중지, 범위 제한 해제
node .ai-workflow/engine/cli.mjs check-scope --path src/a.ts      # 훅과 같은 판단
```

- 진행 중인 작업은 하나뿐이다 (`state/focus.json`). 같은 작업을 다시 `task-start` 하면 재개한다.
- **훅** (`PreToolUse`, Edit·Write·MultiEdit·NotebookEdit): 진행 중 작업이 있으면 그 작업의 `allowedFiles` 와 해당 기능 문서만 고칠 수 있다.
  작업이 없어도 `.ai-workflow/engine/`, `runs/`, `state/`, `.env`, `.git/` 은 항상 막는다.
  승인 이후 기능 문서가 바뀌었으면 다시 승인받기 전까지 코드 수정을 막는다.
- 훅은 셸 명령의 파일 변경은 보지 못한다. 그래서 `task-done` 이 git 으로 다시 확인한다:
  작업 시작 시점의 커밋과 이미 바뀌어 있던 파일의 내용 해시를 기준으로, 이 작업이 바꾼 파일 중 범위 밖이 있으면 `OUT_OF_SCOPE` 로 막는다.
  사용자가 허락하면 `--extra-approved "<사용자 답변 원문>" --user-confirmed` 로 기록을 남기고 넘긴다.
- 모든 작업이 끝나면 검수 단계로 간다.

## 검수·검증·확정·문서

```bash
node .ai-workflow/engine/cli.mjs review        --feature FEAT-001
node .ai-workflow/engine/cli.mjs task-reopen   --feature FEAT-001 --task TASK-001 --reason "R001 지적"
node .ai-workflow/engine/cli.mjs review-accept --feature FEAT-001 --approval-text "<사용자 답변 원문>" --user-confirmed
node .ai-workflow/engine/cli.mjs checks-set    --from <JSON> --approval-text "<사용자 답변 원문>" --user-confirmed
node .ai-workflow/engine/cli.mjs verify        --feature FEAT-001 [--only TEST-002]
node .ai-workflow/engine/cli.mjs test-confirm  --feature FEAT-001 --test TEST-003 --approval-text "<사용자 답변 원문>" --user-confirmed
node .ai-workflow/engine/cli.mjs confirm       --feature FEAT-001 --approval-text "<사용자 답변 원문>" --user-confirmed
node .ai-workflow/engine/cli.mjs docs-done     --feature FEAT-001 --summary "<쓴 문서>"
```

- **검수**: `AIWF_CODEX_BIN exec --sandbox read-only --json --ignore-user-config --ephemeral --model AIWF_REVIEW_MODEL -C <루트> -` 에
  요구사항·설계·작업 계약·바뀐 파일·diff 를 넘기고, REQ 마다 MET/NOT_MET/UNVERIFIED 와 지적을 담은 JSON 을 받는다.
  형식이 틀리거나 파일 변경을 시도하면 결과로 인정하지 않는다. 요청 모델은 기록하지만 실제 응답 모델은 확인할 수 없다.
- **검수 인증**: 기본(`AIWF_REVIEW_AUTH=chatgpt`)은 ChatGPT 구독 로그인만 쓴다. 검수 전에 `codex login status` 로 ChatGPT 로그인을 확인하고,
  아니면(API 키 로그인·미로그인) 막는다. `OPENAI_API_KEY` 등 API 키 환경변수는 검수자에게 넘기지 않는다. API 키 과금을 허용하려면 `any`.
- **프로젝트 검사** (`checks.json`): 린트·빌드·단위 테스트 명령과 http·browser 테스트가 쓰는 서버 주소(`origins`).
  `checks-set` 으로 승인과 함께 저장하고, 승인 뒤 파일이 바뀌면 검증을 막는다. 형식은 `templates/checks.example.json`.
- **기능 테스트** (`tests.json`, 설계 승인에 포함): 형식은 `templates/tests.example.json`.

  | kind | 실행 |
  |---|---|
  | `command` | 셸 명령, 종료 코드 0 이면 통과 |
  | `http` | 요청 하나 → 상태·content-type·본문 문자열·JSON 경로 값 비교 (리다이렉트는 따라가지 않음) |
  | `browser` | Playwright(headless, `AIWF_PLAYWRIGHT_MODULE` 또는 프로젝트 node_modules, `AIWF_BROWSER_CHANNEL`)로 선언형 단계 실행, 스크린샷 저장 |
  | `manual` | 사용자가 확인하고 `test-confirm` 으로 기록 |

  비밀값은 `AIWF_TEST_*` 환경변수로만 받고(`{ "fromEnv": ... }`, `valueFromEnv`), 로그·메시지에서 지운다.
- 결과·로그·스크린샷은 `runs/<RUN>/verify/V###/`, 검수 요청·결과는 `runs/<RUN>/reviews/` 에 남는다 (git 제외).
- **확정 조건**: 검수 결과(승인 또는 사용자 허락)와 확정 단계에서 실행한 전체 검증이 **지금 작업 트리 지문**과 같아야 한다.
  검수·검증 뒤 코드를 고치면 다시 해야 한다.
- **완료**: `docs-done` 이 `features/FEAT-###/report.md` (승인·작업·바뀐 파일·검수·검증·확정·문서 요약)를 만든다.

## Slack 알림

`AIWF_SLACK_ENABLED=true` 이면 단계 전환 이벤트(기능 시작, 기획·설계 승인과 되돌림, 작업 완료·재오픈, 검수, 검증, 확정, 완료)를
실행마다 하나의 스레드로 보낸다. 명령이 끝날 때 자동으로 보내고, `notify` 로 다시 보낼 수 있다 (`--test` 는 연결 확인).

- 전송은 Windows PowerShell(`engine/slack-send.ps1`)이 한다. 토큰 파일은 현재 Windows 사용자로 암호화된 파일
  (DPAPI 또는 `ConvertFrom-SecureString` 출력)이어야 하고, 평문 토큰 파일은 거부한다. Node 는 토큰을 읽지 않는다.
- 사용자 확인이 필요한 이벤트(승인 되돌림, 검수 지적·실패, 검증 실패, 완료)는 `AIWF_SLACK_USER_ID` 를 멘션한다.
- 전송 실패는 기능 상태를 바꾸지 않는다. 수신 여부가 불명확한 알림은 자동으로 다시 보내지 않는다 (`--retry-uncertain`).
- Windows 가 아니면 보내지 않고 `UNSUPPORTED_PLATFORM` 으로 남긴다.

## Claude Code 스킬

| 스킬 | 언제 |
|---|---|
| `/aiwf` | 시작점. `status` 를 보고 단계별 스킬로 넘긴다 |
| `/aiwf-setup` | `questions` → AskUserQuestion → `init --set` 으로 `.env` 를 채운다 |
| `/aiwf-discuss` | `new`, 논의, `decisions.md`·`requirements.md`, 기획 승인 |
| `/aiwf-design` | `design.md`·`tasks.json` (작업 계약), 설계 승인 |
| `/aiwf-develop` | 작업별 `task-start` → 구현 → 확인 → `task-done` |
| `/aiwf-review` | `review`, 지적 정리, `task-reopen` 또는 `review-accept` |
| `/aiwf-verify` | `checks-set`, `verify`, manual 테스트 `test-confirm`, `confirm` |
| `/aiwf-docs` | 문서 작성, `docs-done` |

승인(`approve`, `checks-set`, `review-accept`, `test-confirm`, `confirm`, `--extra-approved`, `--no-docs-approved`)은 사용자가 대화에서 명시적으로 진행을 말한 뒤에만, 그 답변 원문으로 실행한다.

종료 코드: 0 성공, 1 오류, 2 사용법, 3 차단, 4 잠금.

## 개발

```bash
npm test     # 오프라인 테스트 (임시 폴더·실제 git 사용, 제품 파일·네트워크 없음)
```

## 진행 상황

- [x] M1 — 설치, `.env` 질의·검증·git 제외 강제, 기능 생성, 기획·설계 승인 관문, 상태·이벤트·잠금
- [x] M2 — 단계별 Claude Code 스킬, 작업 시작·완료, 수정 범위 훅·git 확인
- [x] M3 — 프로젝트 검사(checks.json)·기능 테스트(tests.json), command·http·browser·manual 실행기, verify
- [x] M4 — Codex 독립 검수, 작업 재오픈, 확정 판정(작업 트리 지문), 문서 단계·보고서, Slack 전송
- [ ] M5 — 실제 프로젝트 시범 운영 (빈 데모 프로젝트에서 전체 흐름을 실제 프로세스로 확인함: 훅, `.cmd` 로 띄운 검수자, Edge 브라우저 테스트, Slack 스레드)
