import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(process.cwd());
const source = join(root, 'frontend');
const target = process.env.RADAR_ARTIFACT_DIR ? resolve(process.env.RADAR_ARTIFACT_DIR) : '/tmp/daili-radar-test-build';
if (target === root || target === source || !target.endsWith('/daili-radar-test-build')) throw new Error('Unsafe artifact directory');
if (!existsSync(join(source, 'src/app/radar-test/page.tsx'))) throw new Error('Radar source page missing');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'next-env.d.ts', 'next.config.ts', 'postcss.config.mjs', 'eslint.config.mjs']) {
  if (existsSync(join(source, name))) cpSync(join(source, name), join(target, name));
}
cpSync(join(source, 'src'), join(target, 'src'), { recursive: true });
// No calendar, auth, order, sheet, cron or payment API is deployed.
rmSync(join(target, 'src/app'), { recursive: true, force: true });
mkdirSync(join(target, 'src/app/api/radar-preview'), { recursive: true });
mkdirSync(join(target, 'src/app/api/radar-ota'), { recursive: true });
mkdirSync(join(target, 'src/app/radar-test'), { recursive: true });
cpSync(join(source, 'src/app/globals.css'), join(target, 'src/app/globals.css'));
cpSync(join(source, 'src/app/radar-test/page.tsx'), join(target, 'src/app/radar-test/page.tsx'));
cpSync(join(source, 'src/app/radar-test/page.tsx'), join(target, 'src/app/page.tsx'));
cpSync(join(source, 'src/app/api/radar-preview/route.ts'), join(target, 'src/app/api/radar-preview/route.ts'));
cpSync(join(source, 'src/app/api/radar-ota/route.ts'), join(target, 'src/app/api/radar-ota/route.ts'));
writeFileSync(join(target, 'src/app/layout.tsx'), `import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Daili｜競品雷達測試站", robots: { index: false, follow: false } };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-Hant"><body style={{ margin: 0, background: "#fff" }}>{children}</body></html>; }
`);
writeFileSync(join(target, 'vercel.json'), JSON.stringify({ framework: 'nextjs', regions: ['hnd1'], headers: [{ source: '/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] }] }, null, 2));
function files(dir, prefix = '') { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name]); }
const routes = files(join(target, 'src/app')).filter(p => /(?:page|route)\.tsx?$/.test(p));
if (JSON.stringify(routes.sort()) !== JSON.stringify(['api/radar-ota/route.ts', 'api/radar-preview/route.ts', 'page.tsx', 'radar-test/page.tsx'])) throw new Error('Unexpected route in isolated artifact');
if (files(target).some(p => p.split('/').some(part => part.startsWith('.env')))) throw new Error('Environment file found in deployment');
const packageJson = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
if (packageJson.dependencies.next !== '16.1.6') throw new Error('Unexpected Next.js dependency; reassess build plan');
if (!packageJson.dependencies['@vercel/sandbox']) throw new Error('Sandbox runtime dependency missing');
console.log(JSON.stringify({ directory: target, routes, productionRoutesIncluded: false, environmentFilesIncluded: false, liveOtaEndpointIncluded: true }));
