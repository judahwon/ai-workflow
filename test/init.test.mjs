import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupProject, git } from './helpers.mjs';
import { readEnvFile } from '../engine/envfile.mjs';
import { main } from '../engine/cli.mjs';

test('install: .gitignore·.env.example·템플릿을 만들고 .env 는 git 에서 제외된다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  const ignore = fs.readFileSync(path.join(p.workflowRoot, '.gitignore'), 'utf8');
  for (const line of ['.env', 'runs/', 'state/', '!.env.example']) assert.ok(ignore.includes(line), line);
  assert.ok(fs.existsSync(path.join(p.workflowRoot, '.env.example')));
  assert.ok(fs.existsSync(path.join(p.workflowRoot, 'templates', 'ko', 'requirements.md')));
  const r = await p.run('init', '--set', 'AIWF_PROJECT_NAME=p');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /git 제외 상태: 제외됨/);
  // 실제 git 에서도 .env 는 보이지 않고 .env.example 은 보인다.
  const files = git(p.projectRoot, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.slice(3));
  assert.ok(!files.includes('.ai-workflow/.env'), files.join(','));
  assert.ok(files.includes('.ai-workflow/.env.example'), files.join(','));
});

test('init --set: 값과 기본값을 .env 에 쓰고 빠진 항목을 알려준다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  let r = await p.run('init', '--set', 'AIWF_SLACK_ENABLED=true');
  assert.equal(r.code, 3);
  assert.match(r.out, /AIWF_PROJECT_NAME/);
  assert.match(r.out, /AIWF_SLACK_USER_ID/);
  r = await p.run('init', '--set', 'AIWF_PROJECT_NAME=데모 "프로젝트"', '--set', 'AIWF_SLACK_ENABLED=false');
  assert.equal(r.code, 0, r.out);
  const env = readEnvFile(path.join(p.workflowRoot, '.env')).values;
  assert.equal(env.AIWF_PROJECT_NAME, '데모 "프로젝트"');
  assert.equal(env.AIWF_DOC_LANGUAGE, 'ko');
  assert.equal(env.AIWF_SLACK_ENABLED, 'false');
});

test('init: 비밀값과 알 수 없는 키는 디스크에 쓰기 전에 거부한다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  let r = await p.run('init', '--set', 'AIWF_SLACK_TOKEN_FILE=xoxb-1234567890-abcdefghij');
  assert.equal(r.code, 3);
  assert.match(r.out, /SECRET_VALUE/);
  assert.ok(!fs.existsSync(path.join(p.workflowRoot, '.env')));
  r = await p.run('init', '--set', 'AIWF_TYPO=1');
  assert.equal(r.code, 2);
});

test('init: 대화형 질의는 잘못된 값을 다시 묻고, 처음에는 모든 항목을 묻는다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  const asked = [];
  const answers = new Map([
    ['프로젝트 이름', ['내 프로젝트']],
    ['문서·보고 언어', ['jp', 'en']],
    ['Slack DM', ['']],
  ]);
  const prompt = async (fn) => fn(async (text) => {
    asked.push(text);
    for (const [prefix, queue] of answers) if (text.startsWith(prefix) && queue.length) return queue.shift();
    return '';
  });
  const output = [];
  const code = await main(['init'], { ...p.overrides, stdinIsTTY: true, prompt, out: (l) => output.push(l) });
  assert.equal(code, 0, output.join('\n'));
  const env = readEnvFile(path.join(p.workflowRoot, '.env')).values;
  assert.equal(env.AIWF_PROJECT_NAME, '내 프로젝트');
  assert.equal(env.AIWF_DOC_LANGUAGE, 'en');
  assert.ok(output.some((l) => l.includes('형식 오류')));
  assert.ok(asked.length >= 15, `질문 ${asked.length}개`);
  // 두 번째 실행은 빠진 항목이 없으니 묻지 않는다.
  asked.length = 0;
  await main(['init'], { ...p.overrides, stdinIsTTY: true, prompt, out: () => {} });
  assert.equal(asked.length, 0);
});

test('init: .env 가 git 에 추적되면 작업 명령을 막는다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  await p.run('init', '--set', 'AIWF_PROJECT_NAME=p');
  git(p.projectRoot, 'add', '-f', '.ai-workflow/.env');
  const status = await p.run('status');
  assert.match(status.out, /이미 git 에 추적됨/);
  const r = await p.run('new', '--title', '기능');
  assert.equal(r.code, 3);
  assert.match(r.out, /ENV_TRACKED/);
});

test('init: .gitignore 에서 .env 줄을 지우면 init 이 되살린다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  await p.run('init', '--set', 'AIWF_PROJECT_NAME=p');
  fs.writeFileSync(path.join(p.workflowRoot, '.gitignore'), 'runs/\n');
  let r = await p.run('new', '--title', '기능');
  assert.match(r.out, /ENV_NOT_IGNORED/);
  r = await p.run('init');
  assert.equal(r.code, 0, r.out);
  r = await p.run('new', '--title', '기능');
  assert.equal(r.code, 0, r.out);
});

test('questions: 질문 목록을 JSON 으로 주고 값은 노출하지 않는다', async (t) => {
  const p = setupProject();
  t.after(p.cleanup);
  await p.run('init', '--set', 'AIWF_PROJECT_NAME=비밀아닌-이름');
  const r = await p.run('questions');
  assert.equal(r.code, 0);
  const items = JSON.parse(r.out);
  const name = items[0].keys.find((k) => k.key === 'AIWF_PROJECT_NAME');
  assert.equal(name.filled, true);
  assert.ok(!r.out.includes('비밀아닌-이름'));
});

test('git 저장소가 아니어도 설치·설정은 되고 상태에 표시된다', async (t) => {
  const p = setupProject({ gitRepo: false });
  t.after(p.cleanup);
  // 임시 폴더가 상위 git 저장소(예: 홈 폴더) 안에 있을 수 있어 git 응답을 주입한다.
  const notARepo = () => ({ status: 128, stdout: '', stderr: 'not a git repository' });
  const output = [];
  const code = await main(['init', '--set', 'AIWF_PROJECT_NAME=p'], { ...p.overrides, git: notARepo, out: (l) => output.push(l) });
  assert.equal(code, 0, output.join('\n'));
  assert.match(output.join('\n'), /git 저장소가 아님/);
});
