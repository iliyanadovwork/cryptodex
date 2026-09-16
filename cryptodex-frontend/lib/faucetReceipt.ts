/**
 * THE FAUCET RECEIPT
 * ==================
 *
 * THE RULE: what the page says AFTER a claim or a reset is read from the API's
 * own `credited` list, never from anything in this file. spotapi
 * controllers/faucet.controller.js builds that list from the very maps it wrote
 * the balances from, so the receipt cannot drift from what actually happened.
 *
 * That rule was learned the hard way: the faucet once credited more wallets
 * than these pages described, so the claim understated what it gave and the
 * reset said a wallet would be "zeroed" and then re-seeded it.
 *
 * The constants below are the only thing that feeds what the page must promise
 * BEFORE a claim, because there is no "what would I get" endpoint - so they
 * name the SPOT grant alone. If the server seeds anything else, the receipt
 * shown after the claim will say so in the server's own words: `walletLabel`
 * names a wallet it does not recognise rather than dropping it, precisely so an
 * unannounced credit is still reported. Understating a promise and then showing
 * the truth is recoverable; promising a credit the server does not make is not.
 */

export type FaucetWallet = "spot" | string;

export interface FaucetCredit {
  coin: string;
  amount: number | string;
  wallet: FaucetWallet;
  balance?: number | string;
}

export interface FaucetReceipt {
  /** Epoch ms the receipt was recorded on this device. */
  at: number;
  kind: "claim" | "reset";
  /**
   * The primary DepositEvent signature the API reported for a claim. Resets
   * create no deposit rows, so they have none. Kept for identification only -
   * the history no longer joins anything to it.
   */
  signature?: string;
  headline?: string;
  credited: FaucetCredit[];
}

/**
 * Mirrors FAUCET_AMOUNT / FAUCET_COINS in spotapi controllers/faucet.controller.js.
 *
 * THIS IS THE FIFTH PIN ON ONE NUMBER, AND IT IS THE ONE THAT GOT MISSED.
 * The seed is pinned in walletapi createAsset.js (DEMO_SEED_AMOUNT), spotapi
 * faucet.controller.js (FAUCET_AMOUNT) and a test on each side. Those four are
 * bound to each other by tests that fail loudly. This copy is bound to nothing:
 * when the seed dropped from 10000 to 1000, all four backend pins were updated
 * and every suite stayed green while the pages went on promising the user ten
 * times what the server would send. A user-visible lie that no test could see.
 *
 * The test beside this file now asserts these amounts, so the frontend fails
 * on drift too - but the honest fix is that a client should not hold a second
 * copy of a server constant at all. `POST /api/spot/faucet/status` already
 * reports what a claim will grant; this array should be replaced by that
 * response once the pre-claim copy can tolerate an async value.
 */
export const FAUCET_SPOT_GRANT: FaucetCredit[] = [
  { coin: "USD", amount: 1000, wallet: "spot" },
];

/**
 * Everything one claim is promised to credit.
 *
 * Identical to FAUCET_SPOT_GRANT now that the spot wallet is the only wallet a
 * product on this venue can spend from. Kept as a separate name because the two
 * mean different things - "what spot gets" and "what the claim gives" - and
 * collapsing them is what would make the next added grant silently invisible on
 * the pre-claim copy.
 */
export const FAUCET_FULL_GRANT: FaucetCredit[] = [...FAUCET_SPOT_GRANT];

const WALLET_LABEL: Record<string, string> = {
  spot: "Spot wallet",
};

/** How a wallet is named on screen. Unknown wallets are named, never dropped. */
export function walletLabel(wallet?: string): string {
  if (!wallet) return "Wallet";
  const known = WALLET_LABEL[wallet];
  if (known) return known;
  return `${wallet.charAt(0).toUpperCase()}${wallet.slice(1)} wallet`;
}

/** Human amount: thousands separated, trailing zeros dropped. */
export function formatCreditAmount(value: number | string | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** "1,000 USD" for one wallet's worth of credits. */
export function creditPhrase(credits: FaucetCredit[]): string {
  return (credits || [])
    .map((c) => `${formatCreditAmount(c.amount)} ${c.coin}`)
    .join(" + ");
}

/**
 * The credits the API actually reported, defensively parsed. A response that
 * omits `credited` yields an empty list rather than an invented one - the page
 * must never describe a credit the API did not report.
 */
export function readCredits(payload: any): FaucetCredit[] {
  const list = payload?.credited;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c: any) => c && c.coin && c.wallet)
    .map((c: any) => ({
      coin: String(c.coin),
      amount: c.amount,
      wallet: String(c.wallet),
      balance: c.balance,
    }));
}

/** Credits grouped by the wallet they landed in, in first-seen order. */
export function groupCreditsByWallet(
  credits: FaucetCredit[]
): Array<{ wallet: string; label: string; credits: FaucetCredit[] }> {
  const order: string[] = [];
  const byWallet = new Map<string, FaucetCredit[]>();
  for (const credit of credits || []) {
    if (!credit || !credit.wallet) continue;
    if (!byWallet.has(credit.wallet)) {
      byWallet.set(credit.wallet, []);
      order.push(credit.wallet);
    }
    byWallet.get(credit.wallet)!.push(credit);
  }
  return order.map((wallet) => ({
    wallet,
    label: walletLabel(wallet),
    credits: byWallet.get(wallet) || [],
  }));
}

/* ------------------------------------------------------------------------- *
 * Receipt storage
 *
 * A toast is gone in three seconds; the outcome of a claim or a reset has to
 * outlive it. Receipts are kept per user in localStorage so the page can show
 * the last one on a reload.
 *
 * THAT IS ALL THEY ARE FOR. They were also used to reconstruct legs of a claim
 * the server recorded no deposit row for - which meant those legs were visible
 * only in the browser that made the claim. The server records every leg now, so
 * the history reads them from the API and a receipt is once again nothing more
 * than a note-to-self about the last claim made here.
 * ------------------------------------------------------------------------- */

const STORAGE_KEY = "cryptodex_faucet_receipts";
const MAX_RECEIPTS_PER_USER = 20;

type ReceiptStore = Record<string, FaucetReceipt[]>;

function readStore(): ReceiptStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ReceiptStore;
  } catch (err) {
    return {};
  }
}

function writeStore(store: ReceiptStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    /* a full or blocked localStorage must never break a claim */
  }
}

/** Newest first. */
export function loadReceipts(userId?: string): FaucetReceipt[] {
  if (!userId) return [];
  const list = readStore()[userId];
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && Array.isArray(r.credited))
    .slice()
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** Records a receipt and returns the stored list, newest first. */
export function saveReceipt(
  userId: string | undefined,
  receipt: FaucetReceipt
): FaucetReceipt[] {
  if (!userId || !receipt) return [];
  const store = readStore();
  const existing = Array.isArray(store[userId]) ? store[userId] : [];
  const next = [receipt, ...existing]
    .sort((a, b) => (b?.at || 0) - (a?.at || 0))
    .slice(0, MAX_RECEIPTS_PER_USER);
  store[userId] = next;
  writeStore(store);
  return next;
}
