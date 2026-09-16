# Deploying Cryptodex on AWS

A runbook from an empty AWS account to a venue that fills orders. Written by doing
it, on 15 September 2026, and corrected where reality disagreed with the plan.

Claims are marked **[measured]** where something was run and the output read,
**[read]** where it rests on reading code, and **[unverified]** where it depends on
a third party that was not tested. An earlier version of this document shipped
confident guesses that turned out to be wrong, so the marks are load-bearing.

**The deployment this describes is live:**
https://cryptodex.52-56-42-231.sslip.io/api/spot/health

---

## 0. The one thing that decides the region

**Binance geoblocks the United States, and this venue has no other price feed.**

Verified the hard way. The first deployment went to `us-east-1` because it is
cheap, and every service reported healthy while the market data never arrived
**[measured]**:

```
[BinanceWS] Error fetching depth snapshot for BTCUSD: Request failed with status code 451
[BinanceWS] Trade stream error for BTCUSD: Unexpected server response: 451
```

451 is "Unavailable For Legal Reasons". Binance says so in the body:

```json
{"code":0,"msg":"Service unavailable from a restricted location according to
 'b. Eligibility' in https://www.binance.com/en/terms."}
```

The same request from London returns 200 **[measured]**. The endpoints are
hard-coded in three string literals in
`cryptodex-spotapi/lib/binanceWebSocket.js` **[read]**, so being blocked is a code
change, not a configuration change.

**Check before you launch anything**, from the region you intend to use:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5'
```

200 means deploy there. 451 means pick another region. This deployment uses
`eu-west-2` (London).

---

## 1. Topology

One EC2 instance. Four containers. No load balancer, no managed database, no NAT
gateway.

```
        internet
           |  :80, :443
       [ caddy ]                    TLS, automatic certificate renewal
           |  :8080 (compose network)
       [  app  ]                    deploy/supervisor.mjs as PID 1
           |                          +- userapi   :2567, gRPC :6001
           |                          +- walletapi :3002, gRPC :6002
           |                          +- spotapi   :2568, gRPC :6003
           |                          +- gateway.mjs on :8080
       [ mongo ] [ redis ]          siblings, no published ports
```

**Why the three services share a container.** They dial each other over
*unauthenticated plaintext gRPC on 127.0.0.1* **[read]**. Splitting them across
hosts or tasks would put that traffic on a network, which is an mTLS project
rather than a topology change. They keep the same six `GRPC_*` variables, so the
split stays a configuration change plus an auth project whenever it is worth doing.
The cost is that they scale and fail together, which for a single-market paper
venue is the right trade.

**Why Mongo and Redis are containers, not DocumentDB and ElastiCache.** Each
managed equivalent costs several times the price of the instance all four run on.
The real cost of this choice is that the host is a single point of failure, and
snapshots are the answer to that rather than a second availability zone.

**Why only Caddy publishes ports.** Mongo and Redis have no `ports` section at
all. An exposed 27017 is found by scanners within the hour.

---

## 2. What it costs

`eu-west-2`, USD, excluding VAT.

| | per month |
|---|---|
| t4g.small | $0 until 31 Dec 2026 on a **Paid** account plan, then ~$13.70 |
| 30 GB gp3 | ~$2.78 |
| Public IPv4 | ~$3.65 |
| ECR (~1.3 GB, 5 tags kept) | ~$0.40 |
| Data transfer out | $0 for the first 100 GB |

**About $7 a month now, about $21 from January 2027.**

**The account plan matters more than any of these numbers.** On the **Free** plan
AWS states: "After your free account plan expires, your account closes
automatically, and you lose access to your resources and data", after six months
or when the $100 credit runs out, whichever comes first. The Free plan also
excludes short-term trials, which is where the free t4g hours come from. A CV link
hosted on a Free-plan account has a six-month self-destruct. Upgrade to Paid: the
credit carries over and nothing else changes.

---

## 3. Runbook

### Step 1 — Guardrails, before any resource exists

- MFA on the root user, then stop using root.
- An IAM admin user for daily work, MFA on that too.
- Billing preferences: Free Tier alerts and CloudWatch billing alerts, both on.
- A zero-spend budget, and a second cost budget alerting on actual and forecast.
- AWS has **no hard spend cap**. Budgets alert; they do not stop anything.

### Step 2 — Registry, role, firewall

```bash
R=eu-west-2

aws ecr create-repository --region $R --repository-name cryptodex-backend \
  --image-scanning-configuration scanOnPush=true

aws ecr put-lifecycle-policy --region $R --repository-name cryptodex-backend \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"keep last 5",
    "selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},
    "action":{"type":"expire"}}]}'

# Instance role: SSM for shell access, ECR read to pull. Nothing else.
aws iam create-role --role-name cryptodex-instance \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
    "Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
for p in AmazonSSMManagedInstanceCore AmazonEC2ContainerRegistryReadOnly; do
  aws iam attach-role-policy --role-name cryptodex-instance \
    --policy-arn arn:aws:iam::aws:policy/$p
done
aws iam create-instance-profile --instance-profile-name cryptodex-instance
aws iam add-role-to-instance-profile --instance-profile-name cryptodex-instance \
  --role-name cryptodex-instance

# 80 and 443 only. No 22: shell access is SSM Session Manager, so there is no key.
VPC=$(aws ec2 describe-vpcs --region $R --filters Name=isDefault,Values=true \
       --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 create-security-group --region $R --group-name cryptodex-web \
       --vpc-id $VPC --description 'HTTP/HTTPS only' --query GroupId --output text)
aws ec2 authorize-security-group-ingress --region $R --group-id $SG --ip-permissions \
  'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
  'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]'
```

**Use the default VPC.** Never the "VPC and more" wizard: it creates a NAT gateway
at $0.05/hour, which is more than everything else here combined.

### Step 3 — The instance

Amazon Linux 2023, **arm64** (the image is built for Graviton), 30 GB gp3
encrypted, IMDSv2 required, and `CpuCredits=standard` so CPU exhaustion throttles
instead of billing surplus credits.

User data installs Docker and the Compose plugin, and creates **2 GB of swap**.
The swap is not optional: 2 GB of RAM shared between three Node processes, Mongo,
Redis and Caddy is exactly where the OOM killer starts choosing victims.

### Step 4 — Build for arm64 and push

The image must be arm64 or it will not start on Graviton. Build it on an Apple
Silicon Mac or a `ubuntu-24.04-arm` runner, never under QEMU emulation: this tree
compiles `bcrypt` and the web3/keccak stack from source, and emulated that turns a
three-minute build into twenty.

```bash
REG=<account>.dkr.ecr.$R.amazonaws.com
docker build --platform linux/arm64 -f deploy/Dockerfile -t cryptodex-backend:local .
aws ecr get-login-password --region $R | docker login --username AWS --password-stdin $REG
docker tag  cryptodex-backend:local $REG/cryptodex-backend:v1
docker push $REG/cryptodex-backend:v1
```

**Lockfiles are committed and the build uses `npm ci`.** They must be generated
*inside* `node:20-bookworm-slim`, not on your laptop **[measured]**. npm 11 on
macOS and npm 10 in the image disagree about how TypeScript 7 lays out its
platform packages, and a lockfile written by the former fails `npm ci` under the
latter with `Missing: typescript@7.0.2 from lock file`.

```bash
docker run --rm --platform linux/arm64 -v "$PWD/cryptodex-userapi:/w" -w /w \
  node:20-bookworm-slim npm install --package-lock-only
```

### Step 5 — Environment

Write `/opt/cryptodex/.env` on the instance, mode 600, never committed. Generate
the secrets on the box so they never transit a laptop or a chat log:

```
SECRET_KEY=$(openssl rand -hex 32)
CRYPTO_SECRET_KEY=$(openssl rand -hex 32)
```

**The four `GRPC_*_URL` variables are required and easy to miss** **[measured]**.
`supervisor.mjs` derives each service's *own* bind address, but every service also
dials the other two, and those addresses come from `GRPC_USER_URL`,
`GRPC_WALLET_URL`, `GRPC_SPOT_URL` and `GRPC_P2P_URL`. Omit them and userapi dies
at boot with `TypeError: Channel target must be a string`, and the supervisor
takes the container down with it, which is correct behaviour and looks alarming:

```
GRPC_USER_URL=127.0.0.1:6001
GRPC_WALLET_URL=127.0.0.1:6002
GRPC_SPOT_URL=127.0.0.1:6003
GRPC_P2P_URL=127.0.0.1:6004
```

### Step 6 — Seed

`ops/reset-and-seed.mjs` **cannot run inside the app container** **[measured]**.
It resolves `mongodb` from userapi, where `mongodb` arrives only via
`mongodb-memory-server`, a devDependency the production image omits.

Run it from a throwaway container on the compose network, with the layout the
script expects and **the exact driver versions userapi pins**:

```bash
mkdir -p seedrun/cryptodex-userapi && cp -r ops seedrun/ops
echo '{"name":"seed-host","version":"1.0.0","private":true}' \
  > seedrun/cryptodex-userapi/package.json
docker run --rm -v /opt/cryptodex/seedrun:/work -w /work/cryptodex-userapi \
  node:20-bookworm-slim npm install mongodb@7.0.0 redis@3.1.2
docker run --rm --network cryptodex_default -v /opt/cryptodex/seedrun:/work \
  node:20-bookworm-slim node /work/ops/reset-and-seed.mjs \
    --mongo-uri mongodb://mongo:27017 --db-prefix cryptodex \
    --redis-url redis://redis:6379 --redis-prefix cryptodex
```

**The versions matter.** `redis@4` changed `createClient` to require an explicit
`.connect()`; the script is written for v3, so with v4 it prints its header and
hangs forever with no error **[measured]**.

Then restart `app`: spotapi loads pairs into Redis at boot and connects the depth
feed there.

### Step 7 — TLS

Point a hostname at the instance and set `SITE_ADDRESS`. Caddy obtains and renews
the certificate itself, with no cron and no certbot.

With no domain to hand, `sslip.io` resolves any embedded IP, which is enough for a
real certificate: `cryptodex.52-56-42-231.sslip.io`. Swap in a real domain later by
changing one variable.

---

## 4. Verifying it actually works

`/api/health` fans out to all three services and returns 200 only when every one
answers. That proves the processes are up. It does **not** prove the venue trades.

**`/api/spot/health` is the one that matters.** It reports the cause, not the
symptom:

| verdict | meaning |
|---|---|
| `ok` | the venue would fill a probe order right now |
| `no_pairs` | databases not seeded. Go to step 6. Not a Binance problem |
| `no_depth` | **the Binance signature.** See section 0 |
| `stale_depth` | the feed connected once and stopped. Also Binance |
| `no_ladder` / `matcher_stalled` | depth is fine, the 2s matching cron is not running |
| `no_admin_liquidity` | the `adminbot@bot.com` Redis entry is missing. Re-run the seed |

Current state of the live deployment **[measured]**:

```json
{"status":"healthy","verdict":"ok",
 "depthFeed":{"summary":{"total":1,"connected":1,"reconnecting":0,"maxSilentForMs":42}}}
```

Streams total with zero connected, alongside `no_depth`, is a blocked region. One
connected stream that has gone silent is an ordinary network wobble.

---

## 5. Operating it

**Shell access** is SSM, so there is no SSH key and port 22 is closed:

```bash
aws ssm start-session --region eu-west-2 --target <instance-id>
```

**What breaks first: memory.** 2 GB shared five ways. Mongo is capped with
`--wiredTigerCacheSizeGB 0.25` because its default is half of RAM, which on this
box is what gets everything OOM-killed.

**Redis is configured as a database, not a cache.** `appendonly yes`,
`appendfsync everysec`, and `maxmemory-policy noeviction`. The last one is
deliberate: Redis is the ledger of record for live trading, and every other policy
silently discards entries when memory fills. Failing writes loudly beats losing
them quietly.

**When the instance dies**, the venue is down until it comes back. Single AZ, by
choice, at this budget. Nightly EBS snapshots via Data Lifecycle Manager are the
recovery path.

**What changes at 100x**: a load balancer in front, a second instance, and Redis
has to leave the host before two of anything can run, because it is the shared
state.

---

## 6. What changed from the Railway deployment

Kept so the change is auditable rather than silent.

- `railway.json`, `.railwayignore` and `railway-api.env.example` are gone.
- Railway injected `$PORT`; here Caddy owns 80 and 443 and the app is fixed on 8080.
- The old runbook used MongoDB Atlas M0 and Upstash Redis free tiers. Both now run
  as containers on the instance. Atlas M0's 100 operations/second cap and its
  automatic pause after 30 idle days were the deciding factors **[unverified]**,
  along with keeping the whole deployment inside AWS.
- The old doc called Binance geoblocking "the top deployment risk". It was right,
  and it was the only prediction in it that had to be paid for in practice.
