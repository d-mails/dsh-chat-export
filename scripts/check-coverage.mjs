import { spawnSync } from 'node:child_process';

const threshold = Number(process.argv[2] ?? '70');
const result = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  'test/core.test.js',
  'test/client.test.js',
  'test/handlers.test.js',
], { encoding: 'utf8' });

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

const match = /all files\s*\|\s*([\d.]+)/u.exec(result.stdout ?? '');
const line = match === null ? null : Number(match[1]);
if (result.status !== 0 || line === null || line < threshold) {
  console.error(`coverage gate failed: line=${line ?? 'unknown'}% (required ${threshold}%)`);
  process.exit(1);
}
console.error(`coverage gate passed: line=${line}% (required ${threshold}%)`);
