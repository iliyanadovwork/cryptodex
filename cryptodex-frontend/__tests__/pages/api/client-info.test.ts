/**
 * client-info route tests
 *
 * This route replaced a browser call to https://ipapi.co/json/ that fired on
 * every login-page mount. It must report the address the server actually saw
 * and must NOT invent a country for a request it knows nothing about.
 */

import handler, {
  buildClientInfo,
  isLoopback,
  resolveClientIp,
} from '@/pages/api/client-info'

describe('resolveClientIp', () => {
  test('prefers the first hop of X-Forwarded-For', () => {
    expect(resolveClientIp('203.0.113.7, 10.0.0.1', '10.0.0.1')).toBe('203.0.113.7')
  })

  test('trims whitespace around the forwarded address', () => {
    expect(resolveClientIp('  203.0.113.7 , 10.0.0.1', '10.0.0.1')).toBe(
      '203.0.113.7'
    )
  })

  test('uses the first entry when the header arrives as an array', () => {
    expect(resolveClientIp(['203.0.113.7', '10.0.0.1'], '10.0.0.1')).toBe(
      '203.0.113.7'
    )
  })

  test('falls back to the socket address with no forwarding header', () => {
    expect(resolveClientIp(undefined, '::1')).toBe('::1')
  })

  test('falls back to the socket address when the header is blank', () => {
    expect(resolveClientIp('', '::1')).toBe('::1')
    expect(resolveClientIp('   ,  ', '::1')).toBe('::1')
  })

  test('is an empty string when neither is available', () => {
    expect(resolveClientIp(undefined, undefined)).toBe('')
  })
})

describe('isLoopback', () => {
  test('recognises the loopback forms a local stack sees', () => {
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('127.1.2.3')).toBe(true)
  })

  test('does not treat a routable address as loopback', () => {
    expect(isLoopback('203.0.113.7')).toBe(false)
    expect(isLoopback('192.168.1.10')).toBe(false)
    expect(isLoopback('1270.0.0.1')).toBe(false)
  })

  test('an absent address is not loopback', () => {
    expect(isLoopback('')).toBe(false)
  })
})

describe('buildClientInfo', () => {
  test('reports a loopback caller as Local', () => {
    expect(buildClientInfo(undefined, '::1')).toEqual({
      ip: '::1',
      country_name: 'Local',
      country_calling_code: '',
      region: 'Local',
    })
  })

  test('never guesses a country for a non-loopback caller', () => {
    const info = buildClientInfo('203.0.113.7', '10.0.0.1')
    expect(info.ip).toBe('203.0.113.7')
    expect(info.country_name).toBe('')
    expect(info.region).toBe('')
  })

  test('reports no calling code at all — this stack cannot know one', () => {
    expect(buildClientInfo(undefined, '::1').country_calling_code).toBe('')
    expect(buildClientInfo('203.0.113.7', undefined).country_calling_code).toBe('')
  })
})

describe('handler', () => {
  test('answers 200 with the resolved client info', () => {
    const json = jest.fn()
    const status = jest.fn(() => ({ json }))
    handler(
      { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: {} } as any,
      { status } as any
    )
    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '203.0.113.7' })
    )
  })

  test('answers even when there is no socket to read', () => {
    const json = jest.fn()
    const status = jest.fn(() => ({ json }))
    handler({ headers: {} } as any, { status } as any)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '', country_name: '' })
    )
  })
})
