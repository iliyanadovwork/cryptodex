# =============================================================================
# CRYPTODEX BACKEND - all three services, one container, one public port.
# =============================================================================
#
# Build from the REPOSITORY ROOT, not from deploy/:
#
#     docker build -f deploy/Dockerfile -t cryptodex-backend .
#
# WHY ONE CONTAINER AND NOT THREE RAILWAY SERVICES
#
# userapi, walletapi and spotapi are not independent products. They are one
# venue: every one of them dials the other two over gRPC, and today those hops
# are plaintext on 127.0.0.1 because the services have always shared a host
# (spotapi/grpc/server.js says so explicitly). Splitting them into three Railway
# services would mean three sets of billed resources on a $5/month plan, three
# internal hostnames to wire into six GRPC_* variables, and - the part that
# actually matters - moving unauthenticated plaintext gRPC off loopback and onto
# a network. Keeping them in one container changes none of that: the gRPC
# channels stay on 127.0.0.1, exactly as they are on the developer's machine,
# and the only thing that has to be reasoned about is the single public port.
#
# The cost is that they scale and fail together. For a solo university project
# on a Hobby plan, that is the right trade.
#
# TWO STAGES because three of these dependency trees compile native code
# (bcrypt in userapi; the web3/keccak stack in walletapi). The builder carries
# python3/make/g++ and is thrown away; the runtime image gets only the compiled
# node_modules, so the toolchain never ships.
#
# LOCKFILES ARE COMMITTED, so this uses `npm ci` rather than `npm install`. The
# difference matters once the image stops being built on the developer's laptop:
# `npm install` re-resolves the tree on every build, so somebody else's patch
# release can change what ships without a single change here, and two of these
# trees compile native code where that failure is a compile error at deploy time
# rather than a test failure. `npm ci` installs exactly the locked tree or fails.
#
# It also fails if package.json and package-lock.json disagree, which is the point:
# a manifest edited without refreshing the lock breaks the build immediately
# instead of silently shipping something nobody chose.

# -----------------------------------------------------------------------------
# Stage 1: build - install production dependencies, compile native modules
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps

# node-gyp needs these. bookworm-slim (glibc) rather than alpine (musl) because
# several of these packages ship glibc prebuilds; on alpine they all fall back
# to compiling, and some do not compile cleanly at all.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /build

# Manifests AND lockfiles first, so a source-only edit does not re-run three
# installs. Both files are needed: npm ci reads the lock but checks it against the
# manifest, and refuses to run if either is missing.
COPY cryptodex-userapi/package.json   cryptodex-userapi/package-lock.json   userapi/
COPY cryptodex-walletapi/package.json cryptodex-walletapi/package-lock.json walletapi/
COPY cryptodex-spotapi/package.json   cryptodex-spotapi/package-lock.json   spotapi/

RUN cd userapi   && npm ci --omit=dev --no-audit --no-fund \
 && cd ../walletapi && npm ci --omit=dev --no-audit --no-fund \
 && cd ../spotapi    && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    USERAPI_PORT=2567 \
    WALLETAPI_PORT=3002 \
    SPOTAPI_PORT=2568 \
    PORT=8080

WORKDIR /app

COPY --from=deps /build/userapi/node_modules   /app/userapi/node_modules
COPY --from=deps /build/walletapi/node_modules /app/walletapi/node_modules
COPY --from=deps /build/spotapi/node_modules   /app/spotapi/node_modules

# Application source. .dockerignore is what keeps local.env / dev.env / prod.env,
# every *.pem/*.key, the mongo data directories and dump.rdb OUT of this image -
# see that file; it is the mechanism, this COPY is just the consumer.
COPY cryptodex-userapi/   /app/userapi/
COPY cryptodex-walletapi/ /app/walletapi/
COPY cryptodex-spotapi/   /app/spotapi/
COPY deploy/                                   /app/deploy/

# ops/reset-and-seed.mjs, so the production databases can be seeded from inside
# the private network (`railway run node ops/reset-and-seed.mjs ...`) rather
# than by exposing Mongo and Redis publicly. It resolves its mongodb and redis
# drivers from userapi/node_modules, which is already here.
COPY ops/                                      /app/ops/

# The services are laid out as /app/{userapi,walletapi,spotapi} because that is
# what the supervisor and the gateway read. ops/reset-and-seed.mjs, however,
# resolves its mongodb and redis drivers through a path built from the
# repository layout:
#
#     createRequire(path.join(REPO_ROOT, 'cryptodex-userapi', ...))
#
# Three symlinks make both layouts true at once, which is better than editing a
# seed script that works: the file that has to keep running unchanged on the
# owner's machine stays byte-identical.
RUN ln -s userapi   /app/cryptodex-userapi \
 && ln -s walletapi /app/cryptodex-walletapi \
 && ln -s spotapi   /app/cryptodex-spotapi

# Belt and braces. If an env file ever slips past .dockerignore - a new name, a
# stale ignore file, a build run with a different context - it dies here rather
# than shipping. Baked credentials in an image layer survive `docker rm`, get
# pushed to the registry, and cannot be rotated by editing a variable.
# No maxdepth cap: it was pinned to today's exact layout (env at depth 2, keys at
# depth 3), so a secret one level deeper - /app/spotapi/config/prod.env, an
# ops/ subdir - would slip past the backstop. Exclude node_modules explicitly
# instead (a dependency's own bundled .env is not ours to police) so the scrub
# covers OUR tree at any depth.
RUN find /app -type f \( -name '*.env' -o -name '.env*' \) -not -path '*/node_modules/*' -delete \
 && find /app -type f \( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \) \
      -not -path '*/node_modules/*' -delete \
 && chown -R node:node /app

# Unprivileged. The node image ships this user; nothing here needs root.
USER node

EXPOSE 8080

# Container-local liveness. Railway uses its own healthcheckPath (see
# railway.json) and ignores this, but `docker ps` shows it for a local run.
# start-period matches the supervisor's per-service waitForPort ceiling (~280s):
# a service opens its port only after its first mongo connect, so a cold managed
# DB can legitimately take minutes to first-listen. Railway uses its own
# healthcheckTimeout and ignores this line, but for a local `docker run` the
# three boot deadlines should still agree.
HEALTHCHECK --interval=30s --timeout=10s --start-period=280s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# PID 1 is the supervisor: it starts the three services and the gateway, tags
# their logs onto stdout, and exits non-zero the moment any one of them dies.
CMD ["node", "deploy/supervisor.mjs"]
