import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

// Keep the production bundler unchanged; compile TSX only for Node DOM tests.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/navigation")
    return {
      url: new URL("./next-navigation-stub.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (specifier.startsWith("@/")) {
    for (const extension of [".ts", ".tsx"]) {
      const url = new URL(
        `../../src/${specifier.slice(2)}${extension}`,
        import.meta.url,
      );
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
  }
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) {
    for (const extension of [".ts", ".tsx"]) {
      const url = new URL(specifier + extension, context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx") || url.endsWith(".ts")) {
    return {
      format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
