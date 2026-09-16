/**
 * Sweep for express handlers with a reachable path that returns without
 * calling res.* — the shape of userapi requestOTP and walletapi getProfitLoss.
 *
 * Approximation: a linear walk over each statement list, recursing into
 * branches. "Responded" means a call to res.<send-ish>() or next(...) has been
 * evaluated on this path. A path that ends (falls off the body, or hits a bare
 * `return`) with responded === false is reported.
 */
const fs = require('fs');
const path = require('path');

/**
 * PARSER RESOLUTION.
 *
 * `@babel/parser` is not a dependency of this repository root - there is no
 * root node_modules with it in - so it is borrowed from whichever service has
 * it installed, resolved RELATIVE TO THIS FILE rather than by absolute path,
 * so this runs on any machine. All four services ship it transitively. If none
 * of them are installed the message says to run npm install rather than
 * printing a stack trace about a missing module.
 */
const REPO_ROOT = path.resolve(__dirname, '..');
const PARSER_HOSTS = [
  'cryptodex-spotapi',
  'cryptodex-userapi',
  'cryptodex-walletapi',
  'cryptodex-frontend',
];

const loadParser = () => {
  for (const host of PARSER_HOSTS) {
    const candidate = path.join(REPO_ROOT, host, 'node_modules', '@babel', 'parser');
    if (fs.existsSync(candidate)) return require(candidate);
  }
  console.error(
    'response-sweep: cannot find @babel/parser.\n' +
      'It is borrowed from a service\'s node_modules; install one of:\n' +
      PARSER_HOSTS.map((h) => `  (cd ${h} && npm install)`).join('\n')
  );
  process.exit(2);
};

const parser = loadParser();

const RES_METHODS = new Set([
  'json', 'send', 'end', 'sendStatus', 'render', 'redirect', 'download',
  'sendFile', 'jsonp', 'write', 'pipe'
]);

function isResCall(node, resName) {
  if (!node || node.type !== 'CallExpression') return false;
  let callee = node.callee;
  if (callee.type !== 'MemberExpression') return false;
  // walk down the member chain looking for the res identifier at the root
  let cur = callee;
  const props = [];
  while (cur.type === 'MemberExpression') {
    if (cur.property && cur.property.name) props.unshift(cur.property.name);
    cur = cur.object;
    if (cur.type === 'CallExpression') cur = cur.callee;
  }
  if (cur.type !== 'Identifier' || cur.name !== resName) return false;
  return props.some((p) => RES_METHODS.has(p));
}

/** `f(..., res, ...)` — the response is the callee's job. */
function delegatesRes(node, resName) {
  let n = node;
  while (n && (n.type === 'AwaitExpression' || n.type === 'UnaryExpression')) n = n.argument;
  if (!n || n.type !== 'CallExpression') return false;
  return n.arguments.some((a) => a && a.type === 'Identifier' && a.name === resName);
}

function isNextCall(node, nextName) {
  return (
    nextName &&
    node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === nextName
  );
}

function containsResponse(node, resName, nextName) {
  let found = false;
  (function walk(n) {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (
      n.type &&
      (isResCall(n, resName) ||
        isNextCall(n, nextName) ||
        delegatesRes(n, resName))
    ) {
      found = true;
      return;
    }
    // DESCEND into nested functions: express handlers in this codebase very
    // often respond from inside a mongoose/multer callback, and treating those
    // as "no response" produced a flood of false positives.
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue;
      walk(n[k]);
    }
  })(node);
  return found;
}

/**
 * Returns { terminated } where terminated === true means every path through
 * these statements ends with a response (or a throw). Pushes findings into
 * `out` for paths that return without responding.
 */
function analyze(stmts, ctx, responded) {
  let r = responded;
  for (const st of stmts) {
    if (!st) continue;
    switch (st.type) {
      case 'ExpressionStatement':
        if (containsResponse(st.expression, ctx.res, ctx.next)) r = true;
        break;
      case 'VariableDeclaration':
        if (containsResponse(st, ctx.res, ctx.next)) r = true;
        break;
      case 'ReturnStatement': {
        if (st.argument && containsResponse(st.argument, ctx.res, ctx.next)) return { end: 'responded' };
        // `return someHandler(req, res)` hands the response off to the callee;
        // spotapi's orderPlace dispatches to limitOrderPlace/marketOrderPlace
        // exactly this way and DOES answer.
        if (st.argument && delegatesRes(st.argument, ctx.res)) return { end: 'responded' };
        if (r) return { end: 'responded' };
        ctx.out.push({ line: st.loc.start.line, kind: 'bare-return' });
        return { end: 'silent' };
      }
      case 'ThrowStatement':
        return { end: 'throw' };
      case 'IfStatement': {
        // `if (sendTwoFactorRefusal(res, ...)) return;` - the TEST is what
        // responds, and the bare `return` inside is the correct way to stop.
        if (containsResponse(st.test, ctx.res, ctx.next)) r = true;
        const consBody = st.consequent.type === 'BlockStatement' ? st.consequent.body : [st.consequent];
        const consR = analyze(consBody, ctx, r);
        if (!st.alternate) {
          // falls through when the test is false; keep r unchanged unless the
          // consequent responded AND fell through
          if (consR.end === 'fall' && consR.responded) r = r || false;
          break;
        }
        const altBody = st.alternate.type === 'BlockStatement' ? st.alternate.body : [st.alternate];
        const altR = analyze(altBody, ctx, r);
        const done = (x) => x.end === 'responded' || x.end === 'throw' || x.end === 'silent';
        if (done(consR) && done(altR)) {
          return { end: consR.end === 'silent' || altR.end === 'silent' ? 'silent-branch' : 'responded' };
        }
        if (consR.responded && altR.responded) r = true;
        break;
      }
      case 'TryStatement': {
        // A try/catch has two continuations: the try block falling off its own
        // end, and the catch block falling off its own end. Only when BOTH
        // definitively end (responded or threw) does the statement itself end
        // the path; otherwise execution continues into the statements after it,
        // and it is the FUNCTION-level fall-through check that decides whether
        // that is a bug. Reporting inner try blocks directly produced false
        // positives on every best-effort `try { cleanup() } catch {}`.
        const tryR = analyze(st.block.body, ctx, r);
        if (!st.handler) {
          if (tryR.responded || tryR.end === 'responded') r = true;
          break;
        }
        const catchR = analyze(st.handler.body.body, ctx, r);
        const done = (x) => x.end === 'responded' || x.end === 'throw' || x.end === 'silent';
        if (done(tryR) && done(catchR)) {
          return {
            end: tryR.end === 'silent' || catchR.end === 'silent' ? 'silent' : 'responded',
          };
        }
        const tryResponded = tryR.end === 'responded' || tryR.responded === true;
        const catchResponded = catchR.end === 'responded' || catchR.responded === true;
        if (tryResponded && catchResponded) r = true;
        break;
      }
      case 'SwitchStatement': {
        let allDone = st.cases.length > 0 && st.cases.some((c) => c.test === null);
        for (const c of st.cases) {
          const cr = analyze(c.consequent, ctx, r);
          if (!(cr.end === 'responded' || cr.end === 'throw')) allDone = false;
        }
        if (allDone) return { end: 'responded' };
        break;
      }
      case 'ForStatement':
      case 'ForOfStatement':
      case 'ForInStatement':
      case 'WhileStatement':
      case 'DoWhileStatement': {
        const body = st.body.type === 'BlockStatement' ? st.body.body : [st.body];
        const br = analyze(body, ctx, r);
        if (br.responded) r = true;
        break;
      }
      case 'BlockStatement': {
        const br = analyze(st.body, ctx, r);
        if (br.end === 'responded' || br.end === 'throw') return br;
        if (br.responded) r = true;
        break;
      }
      default:
        if (containsResponse(st, ctx.res, ctx.next)) r = true;
        break;
    }
  }
  return { end: 'fall', responded: r };
}

function handlerParams(fn) {
  const p = fn.params.map((x) => (x && x.name) || null);
  if (p.length < 2) return null;
  if (p[0] !== 'req' || p[1] !== 'res') return null;
  return { res: p[1], next: p[2] || null };
}

function scanFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parser.parse(src, { sourceType: 'module', plugins: ['optionalChaining', 'nullishCoalescingOperator', 'classProperties', 'objectRestSpread'] });
  } catch (e) {
    return [{ file, name: '<parse error>', line: 0, kind: e.message.slice(0, 80) }];
  }
  const results = [];
  const visit = (node, name) => {
    const params = handlerParams(node);
    if (!params) return;
    const body = node.body.type === 'BlockStatement' ? node.body.body : [];
    const ctx = { res: params.res, next: params.next, out: [] };
    const r = analyze(body, ctx, false);
    if (r.end === 'fall' && !r.responded) {
      ctx.out.push({ line: node.body.loc.end.line, kind: 'body-falls-through' });
    }
    for (const f of ctx.out) results.push({ file, name, ...f });
  };
  for (const st of ast.program.body) {
    let decl = st;
    if (st.type === 'ExportNamedDeclaration' && st.declaration) decl = st.declaration;
    if (decl.type === 'FunctionDeclaration') visit(decl, decl.id.name);
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')) {
          visit(d.init, d.id.name);
        }
      }
    }
  }
  return results;
}

// Roots default to the three backend services, so `node ops/response-sweep.cjs`
// with no arguments sweeps the whole venue. (The frontend has no
// `controllers/` directory and express handlers are not its shape.)
const roots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'cryptodex-userapi',
      'cryptodex-spotapi',
      'cryptodex-walletapi',
    ].map((s) => path.join(REPO_ROOT, s));

const all = [];
for (const root of roots) {
  const dirs = ['controllers'];
  for (const d of dirs) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.js')) continue;
      all.push(...scanFile(path.join(full, f)));
    }
  }
}
for (const r of all) {
  console.log(`${r.file}:${r.line}\t${r.name}\t${r.kind}`);
}
console.log(`\nTOTAL ${all.length}`);
