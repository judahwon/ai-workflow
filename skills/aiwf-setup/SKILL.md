---
name: aiwf-setup
description: ai-workflow 설정(.ai-workflow/.env)을 사용자에게 질의해 채운다. status 가 "init 필요"이거나, 사용자가 프로젝트 이름·회사 문구·Slack·PC 경로 설정을 바꾸려 할 때 쓴다.
---

# 설정 질의 (.ai-workflow/.env)

`.env` 는 git 에서 제외되는 개인·프로젝트 설정이다. 파일을 직접 쓰지 않고 엔진의 `init --set` 으로만 쓴다.

## 순서

1. `node .ai-workflow/engine/cli.mjs questions` 로 항목 목록(JSON)을 받는다. 값은 출력되지 않는다.
   구간(`section`)마다 `keys` 목록이 있고, 항목마다 `key`, `question`, `description`, `default`, `required`, `filled`, `error` 가 있다.
2. 물을 항목을 고른다.
   - 처음 설정이면 전부, 아니면 `filled: false` 이거나 `error` 가 있는 항목, 또는 사용자가 바꾸겠다고 한 항목만.
   - `AIWF_SLACK_ENABLED` 가 `false` 이면 나머지 Slack 항목은 묻지 않는다.
3. **AskUserQuestion** 으로 묻는다. 한 번에 최대 4개 질문을 묶고, 구간(프로젝트 → 이 PC → 알림) 순서로 진행한다.
   - 선택형(`AIWF_DOC_LANGUAGE`, `AIWF_BROWSER_CHANNEL`, `AIWF_SLACK_ENABLED`)은 허용값을 선택지로 준다.
   - 자유 입력 항목은 기본값이 있으면 "기본값 사용 (<값>)", 선택 항목이면 "비워 두기"를 선택지로 두고, 직접 입력은 Other 로 받는다.
   - 경로 항목(`AIWF_CLAUDE_BIN`, `AIWF_CODEX_BIN`, `AIWF_PLAYWRIGHT_MODULE` 등)은 묻기 전에 이 PC 에서 찾아 후보로 제시해도 된다
     (예: `where codex` / `which codex`). 찾은 값도 사용자가 고른 뒤에만 쓴다.
4. 받은 값을 한 번에 저장한다.
   ```bash
   node .ai-workflow/engine/cli.mjs init --non-interactive --set KEY=VALUE --set KEY2=VALUE2
   ```
   - 값을 지우려면 `KEY=` 로 보낸다. 기본값을 쓰기로 했으면 그 키는 보내지 않아도 된다.
   - 셸 인용에 주의한다. 값에 공백·따옴표가 있으면 따옴표로 감싼다.
5. 출력의 빠진 항목·형식 오류·git 제외 상태를 확인한다. 남은 문제가 있으면 그 항목만 다시 묻는다.
6. 설치 출력에 린터 주의(`.ai-workflow/ 제외가 없다`)가 있었으면, 프로젝트 린터 설정의 제외 목록에 `.ai-workflow/` 를 넣자고 사용자에게 제안한다.
   엔진 파일은 프로젝트 코드 규칙을 따르지 않으므로, 넣지 않으면 lint 검사(checks)가 엔진 때문에 실패한다.
7. git 제외 상태가 "추적됨"이면 `git rm --cached .ai-workflow/.env` 가 필요하다고 사용자에게 알린다 (직접 커밋하지 않는다).

## 금지

- 토큰·비밀번호·API 키를 묻거나 저장하지 않는다. Slack 토큰은 암호화된 토큰 **파일 경로**(`AIWF_SLACK_TOKEN_FILE`)만 받는다.
  사용자가 토큰 값을 붙여 넣으면 저장하지 말고 파일 경로를 달라고 한다. 엔진도 토큰 형태 값을 거부한다.
- `.ai-workflow/.env` 를 Write·Edit 로 고치지 않는다 (훅이 막는다).
