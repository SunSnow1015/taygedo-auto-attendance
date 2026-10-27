import { describe, expect, it, vi } from 'vitest'
import {
  createCloudflareSocketFetch,
  type CloudflareConnectLike,
  type CloudflareSocketLike,
} from '../src/runtimes/cloudflare-http1.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('Cloudflare HTTP/1.1 socket transport', () => {
  it('posts the user center form through TLS without Cloudflare fetch headers', async () => {
    const payload = JSON.stringify({ code: 10, msg: 'sdk token 验证失败', ok: false })
    const fixture = createSocketFixture([
      'HTTP/1.1 200 OK',
      'content-type: application/json',
      `content-length: ${encoder.encode(payload).byteLength}`,
      'connection: close',
      '',
      payload,
    ].join('\r\n'))
    const fetchImpl = createCloudflareSocketFetch(fixture.connect)
    const body = 'token=invalid-token&userIdentity=1000000000000000000&appId=10551'

    const response = await fetchImpl('https://bbs-api.tajiduo.com/usercenter/api/login', {
      method: 'POST',
      headers: {
        authorization: '',
        appversion: '1.1.0',
        platform: 'android',
        uid: '10000000',
        deviceid: 'device-1',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/4.12.0',
      },
      body,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ code: 10, msg: 'sdk token 验证失败', ok: false })
    expect(fixture.connect).toHaveBeenCalledWith(
      { hostname: 'bbs-api.tajiduo.com', port: 443 },
      { secureTransport: 'on', allowHalfOpen: true },
    )
    const request = decoder.decode(concatBytes(fixture.writes))
    expect(request).toContain('POST /usercenter/api/login HTTP/1.1\r\n')
    expect(request).toContain('Host: bbs-api.tajiduo.com\r\n')
    expect(request).toContain('appversion: 1.1.0\r\n')
    expect(request).toContain('User-Agent: okhttp/4.12.0\r\n')
    expect(request).toContain('Accept-Encoding: identity\r\n')
    expect(request).toContain('Connection: close\r\n')
    expect(request).toContain(`Content-Length: ${encoder.encode(body).byteLength}\r\n`)
    expect(request.endsWith(body)).toBe(true)
    expect(request.toLowerCase()).not.toContain('cf-connecting-ip')
    expect(fixture.close).toHaveBeenCalledTimes(1)
  })

  it('decodes a chunked JSON response', async () => {
    const payload = JSON.stringify({ code: 0, data: { uid: '1' } })
    const first = payload.slice(0, 8)
    const second = payload.slice(8)
    const rawHead = [
      'HTTP/1.1 200 OK',
      'content-type: application/json',
      'transfer-encoding: chunked',
      'connection: close',
      '',
    ].join('\r\n')
    const raw = `${rawHead}\r\n${encoder.encode(first).byteLength.toString(16)}\r\n${first}\r\n${encoder.encode(second).byteLength.toString(16)}\r\n${second}\r\n0\r\n\r\n`
    const fixture = createSocketFixture(raw)
    const fetchImpl = createCloudflareSocketFetch(fixture.connect)

    const response = await fetchImpl('https://bbs-api.tajiduo.com/usercenter/api/login', {
      method: 'POST',
      body: 'token=x',
    })

    expect(await response.json()).toEqual({ code: 0, data: { uid: '1' } })
  })

  it('supports the fixed refreshToken endpoint without a request body', async () => {
    const payload = JSON.stringify({
      code: 0,
      data: { accessToken: 'new-access', refreshToken: 'new-refresh', uid: '1' },
    })
    const fixture = createSocketFixture([
      'HTTP/1.1 200 OK',
      'content-type: application/json',
      `content-length: ${encoder.encode(payload).byteLength}`,
      'connection: close',
      '',
      payload,
    ].join('\r\n'))
    const fetchImpl = createCloudflareSocketFetch(fixture.connect)

    const response = await fetchImpl('https://bbs-api.tajiduo.com/usercenter/api/refreshToken', {
      method: 'POST',
      headers: {
        authorization: 'refresh-token',
        deviceid: 'device-1',
        appversion: '1.1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/4.12.0',
      },
    })

    expect(await response.json()).toEqual({
      code: 0,
      data: { accessToken: 'new-access', refreshToken: 'new-refresh', uid: '1' },
    })
    const request = decoder.decode(concatBytes(fixture.writes))
    expect(request).toContain('POST /usercenter/api/refreshToken HTTP/1.1\r\n')
    expect(request).toContain('Content-Length: 0\r\n')
  })

  it('rejects any URL outside the fixed user center login endpoint', async () => {
    const fixture = createSocketFixture('')
    const fetchImpl = createCloudflareSocketFetch(fixture.connect)

    await expect(fetchImpl('https://example.com/', { method: 'POST', body: 'x=1' })).rejects.toThrow(
      'only supports Taygedo user center session endpoints',
    )
    expect(fixture.connect).not.toHaveBeenCalled()
  })
})

function createSocketFixture(rawResponse: string): {
  connect: ReturnType<typeof vi.fn<CloudflareConnectLike>>
  writes: Uint8Array[]
  close: ReturnType<typeof vi.fn<CloudflareSocketLike['close']>>
} {
  const writes: Uint8Array[] = []
  const close = vi.fn<CloudflareSocketLike['close']>().mockResolvedValue(undefined)
  const socket: CloudflareSocketLike = {
    opened: Promise.resolve({ remoteAddress: '203.0.113.1' }),
    closed: Promise.resolve(),
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        if (rawResponse) {
          controller.enqueue(encoder.encode(rawResponse))
        }
        controller.close()
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(chunk.slice())
      },
    }),
    close,
  }
  const connect = vi.fn<CloudflareConnectLike>(() => socket)
  return { connect, writes, close }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}
