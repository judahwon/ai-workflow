// 컨트롤러 전역 잠금. 오래된 잠금은 자동 삭제하지 않고 명시적 unlock 명령으로만 보관 처리한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkflowError, appendJsonl } from './util.mjs';

export function lockPath(ctx) {
  return path.join(ctx.workflowRoot, 'state', 'controller.lock');
}

export function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readOwner(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// stale: true(소유 프로세스 종료 확인), false(실행 중), null(판단 불가)
export function assessLock(ctx, owner) {
  if (!owner || !Number.isInteger(owner.pid)) return { stale: null, reason: 'LOCK_FILE_UNREADABLE' };
  if (owner.hostname !== ctx.hostname) return { stale: null, reason: 'OTHER_HOST' };
  if (owner.pid === ctx.pid) return { stale: false, reason: 'SAME_PROCESS' };
  if (!ctx.isPidAlive(owner.pid)) return { stale: true, reason: 'OWNER_PID_NOT_RUNNING' };
  return { stale: false, reason: 'OWNER_RUNNING' };
}

export function inspectLock(ctx) {
  const file = lockPath(ctx);
  if (!fs.existsSync(file)) return null;
  const owner = readOwner(file);
  return { owner: summarize(owner), ...assessLock(ctx, owner) };
}

function summarize(owner) {
  if (!owner) return null;
  return { pid: owner.pid, hostname: owner.hostname, command: owner.command, acquiredAt: owner.acquiredAt };
}

export function acquireLock(ctx, command) {
  const file = lockPath(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = readOwner(file);
    const state = assessLock(ctx, owner);
    const hint = state.stale === true
      ? '소유 프로세스가 종료된 것으로 보인다. 상태 확인 후 `unlock --stale --reason "..."`으로 보관 처리하고 `resume`을 실행한다.'
      : state.stale === null
        ? '소유 상태를 판단할 수 없다. 다른 실행이 없음을 직접 확인한 뒤 `unlock --stale --force-unverified --reason "..."`를 사용한다.'
        : '다른 컨트롤러 명령이 실행 중이다. 종료를 기다린다.';
    throw new WorkflowError('LOCK_HELD', `잠금 사용 중 (${state.reason}). ${hint}`, {
      exitCode: 4,
      details: { owner: summarize(owner), staleSuspected: state.stale, staleReason: state.reason },
    });
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: ctx.pid, hostname: ctx.hostname, command, acquiredAt: ctx.now(), token }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return {
    release() {
      const owner = readOwner(file);
      // 잠금이 그 사이 보관 처리·재획득되었으면 남의 잠금을 지우지 않는다.
      if (owner && owner.token === token) fs.unlinkSync(file);
    },
  };
}

export async function withLock(ctx, command, fn) {
  const lock = acquireLock(ctx, command);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// 삭제가 아닌 보관(rename)과 감사 기록. 실행 중인 소유자의 잠금은 어떤 옵션으로도 해제하지 않는다.
export function breakStaleLock(ctx, { reason, forceUnverified = false }) {
  if (!reason || !String(reason).trim()) throw new WorkflowError('USAGE', '--reason 이 필요하다.', { exitCode: 2 });
  const file = lockPath(ctx);
  if (!fs.existsSync(file)) throw new WorkflowError('NO_LOCK', '해제할 잠금이 없다.');
  const owner = readOwner(file);
  const state = assessLock(ctx, owner);
  if (state.stale === false) {
    throw new WorkflowError('LOCK_OWNER_RUNNING', `잠금 소유 프로세스가 실행 중이라 해제하지 않는다 (${state.reason}).`, { exitCode: 4 });
  }
  if (state.stale === null && !forceUnverified) {
    throw new WorkflowError('LOCK_STALE_UNVERIFIED', `오래된 잠금인지 확인할 수 없다 (${state.reason}). 직접 확인 후 --force-unverified 를 함께 지정한다.`, { exitCode: 4 });
  }
  const archiveDir = path.join(ctx.workflowRoot, 'state', 'lock-archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const archived = path.join(archiveDir, `lock-${ctx.now().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.json`);
  fs.renameSync(file, archived);
  const record = {
    type: 'LOCK_BROKEN',
    at: ctx.now(),
    by: { pid: ctx.pid, hostname: ctx.hostname },
    previousOwner: summarize(owner),
    assessment: state.reason,
    forceUnverified,
    reason: String(reason).slice(0, 500),
    archivedTo: path.relative(ctx.workflowRoot, archived),
  };
  appendJsonl(path.join(ctx.workflowRoot, 'state', 'lock-events.jsonl'), record);
  return record;
}
