import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const teamId = 'team_rtARGegsahiZ6hOY7l2dUWGw';
const projectName = 'daili-radar-test';
const productionProjectId = 'prj_ivLgoZInXdIuwHtzWCH5SFHDSQup';
const directory = '/tmp/daili-radar-test-build';
const cliPath = '/tmp/radar-deploy-tools/node_modules/.bin/vercel';
const token = process.env.VERCEL_TOKEN;
if (!token) throw new Error('Missing deployment credential');
function cli(args, timeout = 60000) {
  const result = spawnSync(cliPath, args, { cwd: directory, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr.replaceAll(token, '[REDACTED]'));
  if (result.status !== 0) throw new Error(`Test-project CLI ${args[0]} failed: exit ${result.status}`);
  return result.stdout ?? '';
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${teamId}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const safeError = JSON.stringify({ code: payload.error?.code, message: payload.error?.message }).replaceAll(token, '[REDACTED]').slice(0, 1200);
    throw new Error(`Vercel ${method} ${path} HTTP ${response.status}: ${safeError}`);
  }
  return response.json();
}
let project = await api(`/v9/projects/${projectName}`);
if (!project) {
  cli(['project', 'add', '--help']);
  cli(['project', 'add', projectName, '--scope', 'sweetfuns-projects', '--token', token]);
  project = await api(`/v9/projects/${projectName}`);
}
if (!project || project.name !== projectName || project.id === productionProjectId || project.accountId !== teamId) throw new Error('Test-project isolation check failed');
// Only this dedicated public-safe test project is made externally testable.
await api(`/v9/projects/${project.id}`, 'PATCH', { ssoProtection: null, framework: 'nextjs', nodeVersion: '22.x' });
const verified = await api(`/v9/projects/${project.id}`);
if (verified?.name !== projectName || verified.ssoProtection) throw new Error('Test project authentication gate still active');
mkdirSync(`${directory}/.vercel`, { recursive: true });
writeFileSync(`${directory}/.vercel/project.json`, JSON.stringify({ projectId: project.id, orgId: teamId, projectName }));
const envs = {
  RADAR_PREVIEW_MODE: 'true', RADAR_BUILD_SHA: process.env.GITHUB_SHA,
  NEXT_PUBLIC_DEMO_MODE: 'true', NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'preview-placeholder', NEXT_TELEMETRY_DISABLED: '1',
};
const args = ['deploy', '--prod', '--yes', '--scope', 'sweetfuns-projects', '--token', token];
for (const [key, value] of Object.entries(envs)) args.push('--env', `${key}=${value}`, '--build-env', `${key}=${value}`);
const output = cli(args, 480000);
const deploymentUrl = (output.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/g) ?? []).at(-1);
if (!deploymentUrl) throw new Error('Deployment URL was not returned');
const publicUrl = `https://${projectName}.vercel.app`;
for (const url of [deploymentUrl, publicUrl]) {
  const response = await fetch(`${url}/api/radar-preview`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Public health check failed: ${response.status}`);
  const health = await response.json();
  if (health.build !== process.env.GITHUB_SHA || health.liveBooking !== false || health.persistence !== 'browser-only') throw new Error('Unexpected deployed build or runtime capability');
}
for (const path of ['/calendar', '/api/v1/bookings', '/api/v1/calendar']) {
  const response = await fetch(publicUrl + path, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (response.status !== 404) throw new Error(`Unrelated route unexpectedly present: ${path}`);
}
mkdirSync('/tmp/radar-deploy-evidence', { recursive: true });
writeFileSync('/tmp/radar-deploy-evidence/deployment.json', JSON.stringify({ publicUrl, deploymentUrl, projectId: project.id, projectName, build: process.env.GITHUB_SHA, productionProjectModified: false, privateRoutesAbsent: true, liveBooking: false }, null, 2));
writeFileSync('/tmp/radar-public-url.txt', publicUrl);
console.log('TEST_DEPLOYMENT_VERIFIED', JSON.stringify({ publicUrl, deploymentUrl, projectName, build: process.env.GITHUB_SHA }));
