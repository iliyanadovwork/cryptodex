/**
 * useRecaptchaToken — A TOKEN, OR THE HONEST ABSENCE OF ONE (CRITICAL)
 * ===================================================================
 *
 * THE BUG THIS HOOK EXISTS TO KILL
 * `_app` stopped mounting GoogleReCaptchaProvider where the production site key
 * cannot work (see lib/recaptcha — the red "Localhost is not supported by this
 * site key." card burned into the corner of every page). But nine auth forms —
 * register, login, forgot-password, reset-password, contact — call
 * `useGoogleReCaptcha()` directly, and OUTSIDE that provider the library's
 * default context hands back an `executeRecaptcha` that THROWS the moment it is
 * called. Every one of those forms catches, toasts "Invalid recaptcha" and
 * refuses to submit. Removing a cosmetic error card would have traded it for an
 * app nobody can register with or log into.
 *
 * So the hook has to be exactly two things at once, and both are load-bearing:
 *
 *   1. `required` — does THIS BUILD ask for a token at all. It is emphatically
 *      NOT "did we get one": where reCAPTCHA is enabled a missing token must
 *      still block, exactly as before, or the hook becomes a way to bypass it.
 *   2. `getToken` — obtains one WITHOUT ever throwing, whatever state the
 *      provider is in: absent, present-but-not-loaded, or the throwing default.
 *
 * Every case below was written by deleting the guard it covers and confirming
 * the suite goes red. The one exception is called out where it appears.
 */

import { renderHook, act } from '@testing-library/react'

// Prefixed `mock` so jest's factory hoisting will let the mocks close over it.
// A plain object rather than jest.fn()s: the jest config sets `resetMocks`,
// which would strip an implementation registered in a factory.
const mockState: {
  enabled: boolean
  executeRecaptcha: ((action: string) => Promise<unknown>) | undefined
  calls: string[]
} = {
  enabled: true,
  executeRecaptcha: undefined,
  calls: [],
}

jest.mock('react-google-recaptcha-v3', () => ({
  __esModule: true,
  useGoogleReCaptcha: () => ({ executeRecaptcha: mockState.executeRecaptcha }),
}))

jest.mock('@/lib/recaptcha', () => ({
  __esModule: true,
  recaptchaEnabledHere: () => mockState.enabled,
}))

import { useRecaptchaToken } from '@/hooks/useRecaptchaToken'

/** An executeRecaptcha that records what it was asked for and resolves it. */
const resolving = (token: unknown) => async (action: string) => {
  mockState.calls.push(action)
  return token
}

/** The library's default-context executeRecaptcha: it throws on call. */
const throwing = () => (action: string): Promise<unknown> => {
  mockState.calls.push(action)
  throw new Error(
    'GoogleReCaptcha Context has not yet been implemented, if you are using useGoogleReCaptcha hook, make sure the hook is called inside component wrapped by GoogleRecaptchaProvider'
  )
}

const getToken = async (action = 'register') => {
  const { result } = renderHook(() => useRecaptchaToken())
  let token: string | undefined
  await act(async () => {
    token = await result.current.getToken(action)
  })
  return token
}

beforeEach(() => {
  mockState.enabled = true
  mockState.executeRecaptcha = undefined
  mockState.calls = []
})

describe('required', () => {
  it('mirrors this build`s answer, both ways', () => {
    mockState.enabled = true
    expect(renderHook(() => useRecaptchaToken()).result.current.required).toBe(true)
    mockState.enabled = false
    expect(renderHook(() => useRecaptchaToken()).result.current.required).toBe(false)
  })

  it('is about the BUILD, not about whether a token was obtained', async () => {
    // The distinction the interface is named for: an enabled reCAPTCHA that
    // cannot produce a token must still report `required`, so the caller still
    // blocks. Collapsing this into "did we get one" would turn every reCAPTCHA
    // outage into an open door.
    mockState.enabled = true
    mockState.executeRecaptcha = throwing()
    const { result } = renderHook(() => useRecaptchaToken())
    expect(result.current.required).toBe(true)
    await act(async () => {
      expect(await result.current.getToken('login')).toBe('')
    })
    expect(result.current.required).toBe(true)
  })
})

describe('getToken', () => {
  it('THE GUARD: a throwing executeRecaptcha yields "" instead of an exception', async () => {
    // This is the exact failure the hook was written for. Outside the provider
    // the library's default context throws synchronously on call; unhandled, it
    // rejects the caller's submit handler and the form toasts "Invalid
    // recaptcha" and refuses — on every auth screen in the app.
    mockState.enabled = true
    mockState.executeRecaptcha = throwing()
    await expect(getToken('register')).resolves.toBe('')
    expect(mockState.calls).toEqual(['register'])
  })

  it('an executeRecaptcha that REJECTS also yields ""', async () => {
    // The other half of the same guard: the throw can arrive as a rejected
    // promise (a network failure, an expired key) rather than synchronously.
    mockState.enabled = true
    mockState.executeRecaptcha = async (action: string) => {
      mockState.calls.push(action)
      throw new Error('network')
    }
    await expect(getToken('login')).resolves.toBe('')
  })

  it('DISABLED: does not call executeRecaptcha at all, and returns ""', async () => {
    // Not merely "returns nothing useful" — it must not TOUCH the provider.
    // Where the badge cannot work, calling it is what renders the error card
    // this whole change exists to remove.
    mockState.enabled = false
    mockState.executeRecaptcha = resolving('a-real-token')
    await expect(getToken('register')).resolves.toBe('')
    expect(mockState.calls).toEqual([])
  })

  it('no executeRecaptcha yet (provider mounted, script still loading) yields ""', async () => {
    // NOTE, HONESTLY: `if (!executeRecaptcha) return ""` cannot be made to fail
    // on removal on its own. Deleted, the call becomes `undefined(action)`,
    // which throws a TypeError inside the very try/catch above and returns the
    // same "". The two guards are behaviourally equivalent here; this case
    // pins the OUTCOME, and only the try/catch is load-bearing for it.
    mockState.enabled = true
    mockState.executeRecaptcha = undefined
    await expect(getToken('register')).resolves.toBe('')
  })

  it('a token that resolves empty-ish becomes "", never undefined or null', async () => {
    // The callers put this straight into a request body. `undefined` there
    // drops the key entirely and `null` serialises as a JSON null; both reach
    // the server as something other than "no token", and one of them is a
    // string the server may try to verify.
    mockState.enabled = true
    for (const empty of [undefined, null, '']) {
      mockState.executeRecaptcha = resolving(empty)
      const token = await getToken('register')
      expect(token).toBe('')
      expect(typeof token).toBe('string')
    }
  })

  it('a real token is passed through untouched, for the action asked for', async () => {
    mockState.enabled = true
    mockState.executeRecaptcha = resolving('03AGdBq26...token')
    await expect(getToken('forgotPassword')).resolves.toBe('03AGdBq26...token')
    expect(mockState.calls).toEqual(['forgotPassword'])
  })

  it('follows the provider when executeRecaptcha arrives late', async () => {
    // The realistic mount order: the provider renders before its script has
    // loaded, so the first render has no executeRecaptcha and a later one does.
    // A getToken memoised without that dependency would keep calling the
    // absent one and every form would submit with an empty token forever.
    mockState.enabled = true
    mockState.executeRecaptcha = undefined
    const { result, rerender } = renderHook(() => useRecaptchaToken())
    await act(async () => {
      expect(await result.current.getToken('register')).toBe('')
    })

    mockState.executeRecaptcha = resolving('late-token')
    rerender()
    await act(async () => {
      expect(await result.current.getToken('register')).toBe('late-token')
    })
    expect(mockState.calls).toEqual(['register'])
  })
})
