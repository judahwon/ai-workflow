// 자식 프로세스 실행: 시간 제한·출력 상한·프로세스 트리 정리.
// 모델 출력을 명령으로 실행하지 않는다. 셸은 사용자가 승인한 테스트 명령(checks.json·tests.json)에만 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const STDERR_CAP = 1024 * 1024;

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ }
  }
}

// 반환: { exitCode, signal, stdout, stderr, timedOut, outputLimitExceeded, spawnError? }
export function runProcess({ command, args = [], cwd, env, input, timeoutMs, shell = false, windowsVerbatimArguments = false, maxOutputBytes = 32 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        ...extra,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        outputLimitExceeded,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    try {
      child = spawn(command, args, { cwd, env, shell, windowsVerbatimArguments, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ spawnError: { code: e.code ?? 'SPAWN_FAILED' } });
      return;
    }
    child.stdout.on('data', (d) => {
      outBytes += d.length;
      if (outBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        killTree(child);
      } else out.push(d);
    });
    child.stderr.on('data', (d) => {
      errBytes += d.length;
      if (errBytes <= STDERR_CAP) err.push(d);
    });
    child.on('error', (e) => finish({ spawnError: { code: e.code ?? 'SPAWN_FAILED' } }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '', 'utf8');
  });
}

// Windows 에서 확장자 없는 이름(codex)을 PATH·PATHEXT 로 찾는다. npm 설치 CLI 는 .cmd 다.
export function resolveExecutable(name, { env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32' || path.extname(name)) return name;
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = path.isAbsolute(name) || name.includes('\\') || name.includes('/') ? [''] : (env.PATH ?? env.Path ?? '').split(';');
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, name + ext) : name + ext;
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return name;
}

function quoteForCmd(arg) {
  return /^[A-Za-z0-9_\-.:\\/=]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`;
}

// .cmd·.bat 는 셸 없이 직접 실행할 수 없어 cmd.exe 로 감싼다. 인자는 엔진이 만든 고정 값뿐이다.
export function buildInvocation(executable, args, { env = process.env, platform = process.platform } = {}) {
  const resolved = resolveExecutable(executable, { env, platform });
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    return { command: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[resolved, ...args].map(quoteForCmd).join(' ')}"`], windowsVerbatimArguments: true };
  }
  return { command: resolved, args, windowsVerbatimArguments: false };
}
