import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = process.env.RADAR_DESKTOP_QUEUE_DIR || resolve(root, '../radar-desktop-state');
const compiled = join(state, 'compiled');
const app = join(state, 'daili-radar-test-build');
mkdirSync(state, { recursive: true, mode: 0o700 });
function run(command, args) { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, RADAR_ARTIFACT_DIR: app } }); if (result.status !== 0) process.exit(result.status || 1); }
run(join(root, 'frontend/node_modules/.bin/tsc'), ['frontend/src/lib/competitor-radar/desktop-queue.ts', '--outDir', compiled, '--module', 'commonjs', '--target', 'es2022', '--esModuleInterop', '--skipLibCheck', '--strict', '--types', 'node', '--typeRoots', 'frontend/node_modules/@types']);
run(process.execPath, ['scripts/prepare-radar-preview.mjs']);
if (!existsSync(join(app, 'node_modules'))) symlinkSync(join(root, 'frontend/node_modules'), join(app, 'node_modules'), 'dir');
const child = spawn(process.execPath, [join(root, 'frontend/node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '43118'], {
  cwd: app, stdio: 'inherit',
  // Isolated artifact has only radar routes. Do not copy production environment files.
  env: { ...process.env, RADAR_PREVIEW_MODE: 'true', RADAR_DESKTOP_QUEUE_DIR: state, NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'radar-local-placeholder' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code || 0));
