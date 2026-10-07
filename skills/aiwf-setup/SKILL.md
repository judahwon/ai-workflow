---
name: aiwf-setup
description: ai-workflow 설정(프로젝트 공통 project.env, 개인 user.env)을 사용자에게 질의해 채운다. status 가 "init 필요"이거나, 사용자가 프로젝트 이름·회사 문구·Slack·PC 경로 설정을 바꾸려 할 때 쓴다.
---

# 설정 질의

설정은 세 파일에 나뉜다. 파일을 직접 쓰지 않고 엔진의 `init --set` 으로만 쓴다. 엔진이 키마다 맞는 파일에 넣는다.

| 구간 (`scope`) | 파일 | 누가 언제 |
|---|---|---|
| 프로젝트·검수 (`project`) | `.ai-workflow/project.env` — 커밋해서 팀이 공유 | 이 프로젝트에서 처음 설정하는 사람이 한 번 |
| 이 PC·알림 (`user`) | `~/.ai-workflow/user.env` — 이 PC 의 모든 프로젝트 공통 | 각자 PC 에서 한 번 |
| 이 프로젝트 전용 개인 값 | `.ai-workflow/.env` — git 제외 | 사용자가 "이 프로젝트에서만 다르게" 를 원할 때 (`--override`) |

## 순서

0. 처음 설정이면(`status` 가 "설정 없음") 이 프로젝트에 `.ai-workflow/` 를 커밋할지 **AskUserQuestion** 으로 묻는다.
   - 팀과 공유(권장): 기능 문서·checks.json 이 저장소에 남는다.
   - 이 PC 에만: 4단계 `init` 에 `--local` 을 붙여 `.ai-workflow/` 를 `.git/info/exclude` 에만 넣는다. 저장소에 흔적이 남지 않는다.
1. `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" questions` 로 항목 목록(JSON)을 받는다. 값은 출력되지 않는다.
   구간(`section`)마다 `scope`(project | user)와 `keys` 목록이 있고, 항목마다 `key`, `question`, `description`, `default`, `required`, `filled`, `source`, `error` 가 있다.
   `source` 는 값을 읽은 곳이다: project | user | local(이 프로젝트 전용) | legacy(예전 .env — init 이 나눠 옮긴다).
2. 물을 항목을 고른다.
   - `project` 구간: 항목이 하나도 `filled` 가 아니면(이 프로젝트 첫 설정) 전부. 이미 있으면 팀이 정한 값이므로 묻지 않는다 — 사용자가 바꾸겠다고 할 때만.
   - `user` 구간: `filled` 가 하나도 없으면(이 PC 첫 설정) 전부, 아니면 `error` 가 있는 항목만.
   - 그 밖에 `error` 가 있는 항목, 사용자가 바꾸겠다고 한 항목.
   - `AIWF_SLACK_ENABLED` 가 `false` 이면 나머지 Slack 항목은 묻지 않는다.
3. **AskUserQuestion** 으로 묻는다. 한 번에 최대 4개 질문을 묶고, 구간(프로젝트 → 이 PC → 알림) 순서로 진행한다.
   - 선택형(`AIWF_DOC_LANGUAGE`, `AIWF_BROWSER_CHANNEL`, `AIWF_SLACK_ENABLED`)은 허용값을 선택지로 준다.
   - 자유 입력 항목은 기본값이 있으면 "기본값 사용 (<값>)", 선택 항목이면 "비워 두기"를 선택지로 두고, 직접 입력은 Other 로 받는다.
   - 경로 항목(`AIWF_CLAUDE_BIN`, `AIWF_CODEX_BIN`, `AIWF_PLAYWRIGHT_MODULE` 등)은 묻기 전에 이 PC 에서 찾아 후보로 제시해도 된다
     (예: `where codex` / `which codex`). 찾은 값도 사용자가 고른 뒤에만 쓴다.
4. 받은 값을 한 번에 저장한다.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" init --non-interactive --set KEY=VALUE --set KEY2=VALUE2
   ```
   - 값을 지우려면 `KEY=` 로 보낸다. 기본값을 쓰기로 했으면 그 키는 보내지 않아도 된다.
   - 셸 인용에 주의한다. 값에 공백·따옴표가 있으면 따옴표로 감싼다.
   - 사용자가 개인 값을 "이 프로젝트에서만" 바꾸려 하면 `--override` 를 붙인다 (그 값만 `.ai-workflow/.env` 에 들어간다).
   - 프로젝트 값을 바꾸면 `project.env` 가 바뀐다. 팀 전체에 적용되므로 커밋이 필요하다고 알린다 (직접 커밋하지 않는다).
5. 출력의 빠진 항목·형식 오류·git 제외 상태를 확인한다. 남은 문제가 있으면 그 항목만 다시 묻는다.
   "예전 .env 에서 옮김" 이 있으면 project.env 가 새로 생겼으니 커밋하라고 알린다.
6. (install.mjs 로 엔진을 프로젝트에 설치한 경우만) 설치 출력에 린터 주의가 있었으면 엔진 파일을 린트에서 빼야 한다. 넣지 않으면 lint 검사(checks)가 엔진 때문에 실패한다. 플러그인이면 프로젝트에 엔진 파일이 없으므로 건너뛴다.
   - `--local` 설치(저장소에 흔적을 남기지 않음)면 린터 설정은 두고 checks.json 의 린트 명령에서 제외한다.
   - 아니면 프로젝트 린터 설정의 제외 목록에 `.ai-workflow/` 를 넣자고 사용자에게 제안한다.
7. git 제외 상태가 "추적됨"이면 `git rm --cached .ai-workflow/.env` 가 필요하다고 사용자에게 알린다 (직접 커밋하지 않는다).

## 금지

- 토큰·비밀번호·API 키를 묻거나 저장하지 않는다. Slack 토큰은 암호화된 토큰 **파일 경로**(`AIWF_SLACK_TOKEN_FILE`)만 받는다.
  사용자가 토큰 값을 붙여 넣으면 저장하지 말고 파일 경로를 달라고 한다. 엔진도 토큰 형태 값을 거부한다.
- `.ai-workflow/project.env`, `.ai-workflow/.env`, `~/.ai-workflow/user.env` 를 Write·Edit 로 고치지 않는다 (훅이 막는다).
- 개인 경로·Slack ID 를 project.env 에 넣지 않는다 (엔진이 개인 설정으로 보낸다).
