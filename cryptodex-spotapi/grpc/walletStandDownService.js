import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

// import config
import config from "../config/index.js";

/**
 * SPOT'S VIEW OF THE AUTHORITY ON "MAY THIS ACCOUNT MOVE VALUE".
 *
 * The freeze that account deactivation applies lives on walletapi's wallet
 * document (`frozen: true`, walletapi lib/walletStandDown.js). Spot never
 * honoured it, so a frozen wallet with a live session could keep placing spot
 * orders, keep locking spot balance, keep claiming from the faucet and keep
 * withdrawing. A guard that only some services honour is not a freeze.
 *
 * This is spot's way of asking. `mode: "check"` is walletapi's read-only
 * preflight; it writes nothing and answers ALREADY_FROZEN / READY / NO_WALLET.
 *
 * WHY THE CONTRACT IS DECLARED HERE AND NOT IN A .proto FILE
 * ----------------------------------------------------------
 * Every other client in this directory reads its .proto off disk, which needs
 * this module's own path - and in an ESM package that means `import.meta.url`,
 * which babel-jest's CommonJS transform cannot evaluate. Those modules get away
 * with it only because every test mocks them wholesale. This one must not be
 * mocked wholesale: it is the freeze authority's client, its failure modes ARE
 * the policy (a missed `known: false` reopens the hole this change closes), and
 * it therefore has to be loadable in a test. `fromJSON` gives the identical
 * package definition from a descriptor that travels with the code, with no
 * filesystem read and no path resolution at all.
 *
 * Nothing here is added to spotapi's own gRPC server (grpc/server.js serves
 * spot.proto and p2p.proto): this is a CLIENT contract, and keeping it out of a
 * .proto file also keeps it out of anything that might register it by accident.
 *
 * THE FIELD NUMBERS ARE THE WIRE FORMAT. gRPC dispatches on the path
 * `/Req/deactivateWallet` and decodes by TAG, not by name, so the service name,
 * the method name and the ids below must match walletapi/grpc/wallet.proto
 * exactly:
 *
 *     service Req { rpc deactivateWallet (deactivateWalletReq)
 *                                returns (deactivateWalletRes) {} }
 *     message deactivateWalletReq { string userId = 1; string mode = 2; }
 *     message deactivateWalletRes { bool status = 1; string message = 2; }
 */
export const WALLET_STAND_DOWN_DESCRIPTOR = {
  nested: {
    Req: {
      methods: {
        deactivateWallet: {
          requestType: "deactivateWalletReq",
          responseType: "deactivateWalletRes",
        },
      },
    },
    deactivateWalletReq: {
      fields: {
        userId: { type: "string", id: 1 },
        mode: { type: "string", id: 2 }, // "" | "freeze" | "unfreeze" | "check"
      },
    },
    deactivateWalletRes: {
      fields: {
        status: { type: "bool", id: 1 },
        message: { type: "string", id: 2 },
      },
    },
  },
};

const options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

/**
 * THE CLIENT IS BUILT LAZILY. grpc-js resolves the target at construction, and
 * `config.GRPC.WALLET_URL` is undefined under `NODE_ENV=test` (no dotenv, so
 * nothing populates process.env), which makes construction itself throw.
 * Building at module scope would therefore turn merely IMPORTING any module
 * that transitively reaches this file into a failure in the test environment -
 * and the whole point of splitting the guard away from the controller is that
 * it can be imported cheaply. It is built on first use and reused thereafter.
 */
let client = null;
const getClient = () => {
  if (client) return client;
  const pkgDef = protoLoader.fromJSON(WALLET_STAND_DOWN_DESCRIPTOR, options);
  const Wallet = grpc.loadPackageDefinition(pkgDef).Req;
  client = new Wallet(config.GRPC.WALLET_URL, grpc.credentials.createInsecure());
  return client;
};

/**
 * A DEADLINE IS NOT OPTIONAL HERE. This call sits in front of every order
 * placement, so a walletapi that accepts connections and never answers would,
 * without one, hang the order path indefinitely. Five seconds matches the
 * deadline the rest of this service's wallet calls already use, and a timeout
 * arrives as `known: false` - which the caller treats as UNKNOWN, which on a
 * value-moving route is a refusal.
 */
const DEADLINE_MS = 5000;

/** Test seam, and the only way to drop a client built against a stale target. */
export const __resetWalletStandDownClient = () => {
  client = null;
};

/**
 * Is this user's wallet frozen?
 *
 * Answers { known, frozen } and NEVER rejects. `known: false` is the honest
 * answer when walletapi cannot be reached, times out, or replies in a shape
 * this does not understand - callers treat it as "unknown", which on a
 * value-moving route is a refusal (lib/accountStandDown.js#resolveStandDown).
 *
 * `NO_WALLET` is `frozen: false`: a user with no wallet document has no frozen
 * wallet. They also have no spot balance to move, so nothing turns on it.
 */
export const checkWalletFrozen = async (userId) => {
  try {
    const resp = await new Promise((resolve, reject) => {
      const deadline = new Date();
      deadline.setMilliseconds(deadline.getMilliseconds() + DEADLINE_MS);
      getClient().deactivateWallet(
        { userId: String(userId), mode: "check" },
        { deadline },
        (err, response) => {
          if (err) reject(err);
          else resolve(response);
        }
      );
    });
    if (!resp || resp.status !== true) {
      // walletapi could not decide (bad id, database unreachable). Unknown.
      console.log("checkWalletFrozen: walletapi refused", String(userId), resp);
      return { known: false, frozen: false, message: resp && resp.message };
    }
    return {
      known: true,
      frozen: resp.message === "ALREADY_FROZEN",
      message: resp.message,
    };
  } catch (err) {
    console.log("checkWalletFrozen: failed", String(userId), err && err.message);
    return { known: false, frozen: false };
  }
};
