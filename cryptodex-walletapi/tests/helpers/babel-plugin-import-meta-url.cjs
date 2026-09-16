"use strict";

/**
 * Babel plugin (test-env only, wired up in babel.config.js):
 * rewrites `import.meta.url` to a CommonJS-safe equivalent.
 *
 * babel-jest compiles this ESM codebase to CJS, but @babel/preset-env leaves
 * `import.meta` untouched, which is a SyntaxError inside Jest's CJS module
 * wrapper. Modules like controllers/wallet.controller.js derive __dirname from
 * `import.meta.url` at load time, so without this rewrite they cannot be
 * imported in tests at all.
 */
module.exports = function importMetaUrlToCjs({ template }) {
  const urlExpr = template.expression(
    "require('url').pathToFileURL(__filename).href"
  );
  const metaExpr = template.expression(
    "({ url: require('url').pathToFileURL(__filename).href })"
  );

  return {
    name: "import-meta-url-to-cjs",
    visitor: {
      MetaProperty(path) {
        if (
          path.node.meta.name !== "import" ||
          path.node.property.name !== "meta"
        ) {
          return;
        }
        const parent = path.parentPath;
        if (
          parent.isMemberExpression({ computed: false }) &&
          parent.node.property.name === "url"
        ) {
          parent.replaceWith(urlExpr());
        } else {
          path.replaceWith(metaExpr());
        }
      },
    },
  };
};
