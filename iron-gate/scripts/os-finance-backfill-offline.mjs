#!/usr/bin/env node
import {readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planOsFinanceBackfill,reconcileOsFinanceBackfill} from
  '../src/os-finance-backfill.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
function within(path,root) {
  const location = relative(root,path);
  return location === '' || location === '.' ||
    !location.startsWith('..') && !isAbsolute(location);
}
async function privateInput(path) {
  if (!isAbsolute(path)) throw Error('ABSOLUTE_PRIVATE_PATH_REQUIRED');
  const real = await realpath(path);
  if (within(real,repo)) throw Error('PRIVATE_INPUT_OUTSIDE_REPOSITORY_REQUIRED');
  if ((await stat(real)).size > 64*1024*1024) throw Error('INPUT_TOO_LARGE');
  return JSON.parse(await readFile(real,'utf8'));
}
async function privateOutput(path,result) {
  if (!isAbsolute(path)) throw Error('ABSOLUTE_PRIVATE_PATH_REQUIRED');
  const parent = await realpath(dirname(path));
  if (within(parent,repo)) throw Error('PRIVATE_OUTPUT_OUTSIDE_REPOSITORY_REQUIRED');
  await writeFile(path,`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o600});
}
async function main(args) {
  const [mode,...paths] = args;
  if (mode === 'plan' && paths.length === 2) {
    const plan = planOsFinanceBackfill(await privateInput(paths[0]));
    await privateOutput(paths[1],plan);
    process.stdout.write(JSON.stringify({mode,property_id:plan.property_id,
      snapshot_hash:plan.snapshot_hash,coverage_complete:plan.coverage_complete,
      summary:plan.summary,issues:plan.issues.length})+'\n');
  } else if (mode === 'reconcile' && paths.length === 3) {
    const [plan,readback] = await Promise.all(paths.slice(0,2).map(privateInput));
    const report = reconcileOsFinanceBackfill(plan,readback);
    await privateOutput(paths[2],report);
    process.stdout.write(JSON.stringify({mode,status:report.status,
      snapshot_hash:report.snapshot_hash,as_of_change_seq:report.as_of_change_seq,
      differences:report.differences.length})+'\n');
  } else throw Error('USAGE: plan BUNDLE.json PLAN.json | reconcile PLAN.json READBACK.json REPORT.json');
}
main(process.argv.slice(2)).catch(error=>{
  process.stderr.write(`${error.message}\n`);
  process.exitCode=1;
});
