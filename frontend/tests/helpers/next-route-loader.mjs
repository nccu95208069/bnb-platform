import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier.startsWith('@/')) return {url:pathToFileURL(pathResolve(fileURLToPath(new URL('../../src/', import.meta.url)), specifier.slice(2)+'.ts')).href, shortCircuit:true};
  return nextResolve(specifier, context);
}
