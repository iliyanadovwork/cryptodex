/**
 * Babel Configuration for Jest Tests
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export default (api) => {
  // api.env() registers env-based cache invalidation with Babel.
  const isTest = api.env('test');

  return {
    presets: [
      ['@babel/preset-env', {
        targets: {
          node: '18'
        }
      }]
    ],
    // Test-only: babel-jest compiles ESM -> CJS, where a bare `import.meta`
    // is a SyntaxError. Rewrite `import.meta.url` so controllers that derive
    // __dirname from it (e.g. wallet.controller.js) stay importable in Jest.
    // The running app (babel_hook / babel-node) is unaffected outside NODE_ENV=test.
    plugins: isTest
      ? [join(here, 'tests/helpers/babel-plugin-import-meta-url.cjs')]
      : []
  };
};
