import {existsSync} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier.startsWith('@/')) return {url:pathToFileURL(pathResolve(fileURLToPath(new URL('../../src/', import.meta.url)), specifier.slice(2)+'.ts')).href, shortCircuit:true};
  if(specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)){const url=new URL(specifier+'.ts',context.parentURL);if(existsSync(url))return {url:url.href,shortCircuit:true};}
  return nextResolve(specifier, context);
}
