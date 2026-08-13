// @gatedflow/dsh — DSH client-module builder.
//
// The browser loader (@deepseek-ai/dsh-client-modules) uses a "lazy-CJS"
// contract: when a plugin's client bundle executes, it must ONLY register a
// factory via `window.__ModuleLoader__.load({ id, factory })`. The real module
// code lives inside the factory closure and runs later, at materialization
// (`factory(require)` → exports). Plain `tsc` emits standard ESM that runs to
// completion without ever registering, so the host fails with:
//
//   client-modules: bundle /plugins/@gatedflow/dsh/client.js?rev=… loaded
//   without registering "@gatedflow/dsh" via __ModuleLoader__.load
//
// This script bundles src/client.ts into that factory form and overwrites the
// tsc-emitted lib/client.js. `react` stays external (the web shell provides it
// through its module table, exactly like every official dsh-client-ui-* bundle);
// schemastery is inlined so the factory is self-contained (it is not present in
// the loader's module table, and no official client bundle requires it).

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Must match the boot-graph id the Node host records for this package
// (`@gatedflow/dsh`), NOT the Cordis plugin `name` (`@gatedflow/dsh-client`).
const MODULE_ID = '@gatedflow/dsh'

const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(MODULE_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
`

const footer = `
\t\treturn module.exports;
\t}
});
`

await build({
  entryPoints: [resolve(pkgRoot, 'src/client.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  absWorkingDir: pkgRoot,
  outfile: resolve(pkgRoot, 'lib/client.js'),
  sourcemap: true,
  logLevel: 'info',
  // Provided by the web shell's module table; mirror official client bundles.
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  banner: { js: banner },
  footer: { js: footer },
})
