export { resolve } from "./customer-component-loader.mjs";
import { load as componentLoad } from "./customer-component-loader.mjs";
export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) return {
    format: "module", shortCircuit: true,
    source: 'export default new Proxy({}, { get: (_, name) => String(name) });',
  };
  return componentLoad(url, context, nextLoad);
}
