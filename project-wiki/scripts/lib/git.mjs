import { execFileSync } from 'node:child_process';

export function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}
