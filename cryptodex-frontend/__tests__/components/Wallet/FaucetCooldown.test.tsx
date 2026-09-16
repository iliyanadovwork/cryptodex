/**
 * THE 24H COOLDOWN IS SHOWN, NOT DISCOVERED BY BEING REFUSED
 * ==========================================================
 *
 * The faucet allows one claim per account per 24 hours. That is a product
 * rule - not the anti-abuse machinery this venue deliberately does without -
 * but the page had no way to ask about it: the Claim button stayed enabled for
 * the whole day, and the user learned the rule by pressing it and being handed
 * a red 429 toast for behaving exactly as designed.
 *
 * spotapi now answers GET /api/spot/faucet/status with the same `retryAfter`
 * it would have put in the 429, so the wait can be stated BEFORE the click.
 *
 * Guards:
 *   F1  a claimable account is unaffected - the button is live and unlabelled
 *       by any wait;
 *   F2  an account inside its cooldown gets a DISABLED button, a wait, and no
 *       request when it is clicked;
 *   F3  the wait counts down in place;
 *   F4  a 429 that arrives anyway (the claim raced the status read) puts the
 *       page into the same state, from the 429's own retryAfter;
 *   F5  a status read that FAILS leaves the button enabled - not knowing the
 *       cooldown must not become a reason to refuse a claim the server would
 *       have allowed;
 *   F6  a successful claim re-asks the server rather than assuming 24h.
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

jest.mock("next/image", () => ({
  __esModule: true,
  default: (p: any) => <img {...p} />,
}));
jest.mock("next/router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/services/Wallet/WalletService", () => ({
  faucetClaim: jest.fn(),
  faucetStatus: jest.fn(),
}));
jest.mock("@/store/Wallet/dataSlice", () => ({
  getAssetData: () => ({ type: "noop" }),
  refreshWalletBalances: () => ({ type: "noop" }),
}));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));
jest.mock("@/components/Wallet/DepositHistory", () => ({
  __esModule: true,
  default: () => <div data-testid="deposit-history" />,
}));

import FaucetForm, { formatCountdown } from "@/components/Wallet/FaucetForm";
import {
  faucetClaim,
  faucetStatus,
} from "@/services/Wallet/WalletService";

const renderPage = () => {
  const store = configureStore({
    reducer: {
      auth: () => ({ user: { _id: "u1", userId: "100001" } }),
      wallet: () => ({ assets: [{ coin: "USDC", spotBal: "0" }] }),
    },
  });
  return render(
    <Provider store={store}>
      <FaucetForm />
    </Provider>
  );
};

const claimButton = () =>
  screen.getByTestId("faucet-claim-button") as HTMLButtonElement;

const status = (over: any = {}) => ({
  data: {
    success: true,
    canClaim: true,
    retryAfter: 0,
    cooldownSeconds: 86400,
    ...over,
  },
});

beforeEach(() => {
  (faucetClaim as jest.Mock).mockReset();
  (faucetStatus as jest.Mock).mockReset();
  (faucetStatus as jest.Mock).mockResolvedValue(status());
  (faucetClaim as jest.Mock).mockResolvedValue({
    data: { success: true, message: "credited" },
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("formatCountdown", () => {
  it.each([
    [0, "0s"],
    [45, "45s"],
    [90, "1m 30s"],
    [3600, "1h 00m"],
    [3661, "1h 01m"],
    [86399, "23h 59m"],
  ])("%ss reads as %s", (seconds, expected) => {
    expect(formatCountdown(seconds as number)).toBe(expected);
  });
});

describe("F1 an account that may claim", () => {
  it("asks the server on mount", async () => {
    renderPage();
    await waitFor(() => expect(faucetStatus).toHaveBeenCalledTimes(1));
  });

  it("leaves the button enabled and shows no wait", async () => {
    renderPage();
    await waitFor(() => expect(faucetStatus).toHaveBeenCalled());
    expect(claimButton().disabled).toBe(false);
    expect(screen.queryByTestId("faucet-cooldown")).toBeNull();
  });
});

describe("F2 an account inside its cooldown", () => {
  beforeEach(() => {
    (faucetStatus as jest.Mock).mockResolvedValue(
      status({ canClaim: false, retryAfter: 3 * 3600 + 61 })
    );
  });

  it("disables the button", async () => {
    renderPage();
    await waitFor(() => expect(claimButton().disabled).toBe(true));
  });

  it("says when the account may claim again", async () => {
    renderPage();
    const note = await screen.findByTestId("faucet-cooldown");
    expect(note.textContent).toContain("3h 01m");
    expect(note.textContent).toMatch(/once every 24 hours/i);
  });

  it("names the wait on the button itself", async () => {
    renderPage();
    await waitFor(() =>
      expect(claimButton().textContent).toContain("Next claim in")
    );
  });

  it("does not send a claim the server would refuse", async () => {
    renderPage();
    await waitFor(() => expect(claimButton().disabled).toBe(true));
    fireEvent.click(claimButton());
    expect(faucetClaim).not.toHaveBeenCalled();
  });
});

describe("F3 the wait counts down", () => {
  it("decreases in place", async () => {
    jest.useFakeTimers();
    (faucetStatus as jest.Mock).mockResolvedValue(
      status({ canClaim: false, retryAfter: 65 })
    );
    renderPage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("faucet-cooldown").textContent).toContain(
      "1m 05s"
    );
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(screen.getByTestId("faucet-cooldown").textContent).toContain("55s");
  });

  it("re-enables the button when it reaches zero", async () => {
    jest.useFakeTimers();
    (faucetStatus as jest.Mock).mockResolvedValue(
      status({ canClaim: false, retryAfter: 3 })
    );
    renderPage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(claimButton().disabled).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(claimButton().disabled).toBe(false);
  });
});

describe("F4 a 429 that arrives anyway", () => {
  it("puts the page into the cooldown state from the 429's own retryAfter", async () => {
    (faucetClaim as jest.Mock).mockRejectedValue({
      response: {
        status: 429,
        data: {
          success: false,
          message: "Faucet already claimed, please try again later",
          retryAfter: 7200,
        },
      },
    });
    renderPage();
    await waitFor(() => expect(claimButton().disabled).toBe(false));
    fireEvent.click(claimButton());
    const note = await screen.findByTestId("faucet-cooldown");
    expect(note.textContent).toContain("2h 00m");
    expect(claimButton().disabled).toBe(true);
  });
});

describe("F5 a status read that fails", () => {
  it("leaves the button enabled rather than locking the user out", async () => {
    (faucetStatus as jest.Mock).mockRejectedValue(new Error("network"));
    renderPage();
    await waitFor(() => expect(faucetStatus).toHaveBeenCalled());
    expect(claimButton().disabled).toBe(false);
    expect(screen.queryByTestId("faucet-cooldown")).toBeNull();
  });

  it("still allows the claim through", async () => {
    (faucetStatus as jest.Mock).mockRejectedValue(new Error("network"));
    renderPage();
    await waitFor(() => expect(faucetStatus).toHaveBeenCalled());
    fireEvent.click(claimButton());
    await waitFor(() => expect(faucetClaim).toHaveBeenCalledTimes(1));
  });
});

describe("F6 after a successful claim", () => {
  it("re-asks the server for the new cooldown", async () => {
    (faucetStatus as jest.Mock)
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ canClaim: false, retryAfter: 86400 }));
    renderPage();
    await waitFor(() => expect(faucetStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(claimButton());
    await waitFor(() => expect(faucetStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(claimButton().disabled).toBe(true));
  });
});
