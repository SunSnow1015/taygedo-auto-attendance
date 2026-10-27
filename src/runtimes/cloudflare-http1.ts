type SocketInfoLike = {
  remoteAddress?: string
  localAddress?: string
}

export interface CloudflareSocketLike {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  readonly opened: Promise<SocketInfoLike>
  readonly closed: Promise<void>
  close(): Promise<void>
}

export type CloudflareConnectLike = (
  address: { hostname: string, port: number },
  options: { secureTransport: 'on', allowHalfOpen: true },
) => CloudflareSocketLike

const USER_CENTER_SESSION_URLS = new Set([
  'https://bbs-api.tajiduo.com/usercenter/api/login',
  'https://bbs-api.tajiduo.com/usercenter/api/refreshToken',
])
const RESPONSE_TIMEOUT_MS = 12_000
const MAX_RESPONSE_HEADER_BYTES = 32 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'authorization',
  'appversion',
  'platform',
  'uid',
  'debug-uid',
  'deviceid',
  'ds',
  'content-type',
  'user-agent',
])
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function createCloudflareSocketFetch(connectImpl: CloudflareConnectLike): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    if (!USER_CENTER_SESSION_URLS.has(url.href)) {
      throw new Error('Cloudflare socket transport only supports Taygedo user center session endpoints')
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method !== 'POST') {
      throw new Error('Cloudflare socket transport only supports POST')
    }

    const body = await requestBodyBytes(input, init)
    const headerLines = requestHeaderLines(input, init)
    const requestHead = [
      `POST ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.hostname}`,
      ...headerLines,
      'Accept-Encoding: identity',
      'Connection: close',
      `Content-Length: ${body.byteLength}`,
      '',
      '',
    ].join('\r\n')
    const requestBytes = concatBytes([textEncoder.encode(requestHead), body])

    const socket = connectImpl({ hostname: url.hostname, port: 443 }, {
      secureTransport: 'on',
      allowHalfOpen: true,
    })
    void socket.closed.catch(() => {})
    let timedOut = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        sendAndRead(socket, requestBytes),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true
            void socket.close().catch(() => {})
            reject(new Error('Cloudflare socket request timed out'))
          }, RESPONSE_TIMEOUT_MS)
        }),
      ])
    }
    finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      if (timedOut) {
        void socket.close().catch(() => {})
      }
      else {
        await socket.close().catch(() => {})
      }
    }
  }) as typeof fetch
}

export const cloudflareUserCenterFetch: typeof fetch = async (input, init) => {
  let connect: CloudflareConnectLike
  try {
    const sockets = await import('cloudflare:sockets')
    connect = sockets.connect
  }
  catch {
    console.warn('[taygedo-login] transport=cloudflare-socket unavailable fallback=fetch')
    return globalThis.fetch(input, init)
  }
  return createCloudflareSocketFetch(connect)(input, init)
}

async function requestBodyBytes(input: string | URL | Request, init?: RequestInit): Promise<Uint8Array> {
  if (init?.body === undefined || init.body === null) {
    if (input instanceof Request) {
      return new Uint8Array(await input.clone().arrayBuffer())
    }
    return new Uint8Array()
  }
  if (typeof init.body === 'string') {
    return textEncoder.encode(init.body)
  }
  if (init.body instanceof URLSearchParams) {
    return textEncoder.encode(init.body.toString())
  }
  if (init.body instanceof ArrayBuffer) {
    return new Uint8Array(init.body)
  }
  if (ArrayBuffer.isView(init.body)) {
    return new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength)
  }
  throw new Error('Cloudflare socket transport received an unsupported request body')
}

function requestHeaderLines(input: string | URL | Request, init?: RequestInit): string[] {
  const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined)
  const entries = headerEntries(headers)
  const reserved = new Set(['host', 'content-length', 'accept-encoding', 'connection', 'transfer-encoding'])
  return entries.flatMap(([name, value]) => {
    const lowerName = name.toLowerCase()
    if (reserved.has(lowerName)) {
      return []
    }
    if (!ALLOWED_REQUEST_HEADERS.has(lowerName)) {
      throw new Error(`Cloudflare socket transport rejected unsupported header ${name}`)
    }
    if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
      throw new Error('Cloudflare socket transport rejected an invalid request header')
    }
    return [`${name}: ${value}`]
  })
}

function headerEntries(headers: HeadersInit | undefined): Array<[string, string]> {
  if (!headers) {
    return []
  }
  if (headers instanceof Headers) {
    return [...headers.entries()]
  }
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => [name, value])
  }
  return Object.entries(headers)
}

async function sendAndRead(socket: CloudflareSocketLike, requestBytes: Uint8Array): Promise<Response> {
  await socket.opened
  const writer = socket.writable.getWriter()
  try {
    await writer.write(requestBytes)
  }
  finally {
    writer.releaseLock()
  }
  const rawResponse = await readAllBytes(socket.readable)
  return parseHttp1Response(rawResponse)
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value) {
        continue
      }
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error('Cloudflare socket response exceeded the size limit')
      }
      chunks.push(value)
    }
  }
  finally {
    reader.releaseLock()
  }
  return concatBytes(chunks, total)
}

function parseHttp1Response(raw: Uint8Array): Response {
  const headerEnd = findSequence(raw, new Uint8Array([13, 10, 13, 10]))
  if (headerEnd === -1) {
    throw new Error('Cloudflare socket returned an invalid HTTP response')
  }
  if (headerEnd > MAX_RESPONSE_HEADER_BYTES) {
    throw new Error('Cloudflare socket response headers exceeded the size limit')
  }

  const headerText = textDecoder.decode(raw.subarray(0, headerEnd))
  const lines = headerText.split('\r\n')
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/.exec(lines.shift() ?? '')
  if (!statusMatch) {
    throw new Error('Cloudflare socket returned an invalid HTTP status line')
  }

  const status = Number(statusMatch[1])
  const statusText = statusMatch[2] ?? ''
  const headers = new Headers()
  let contentLength: number | undefined
  let chunked = false
  let contentEncoding = ''
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator <= 0) {
      continue
    }
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    const lowerName = name.toLowerCase()
    if (lowerName === 'content-length') {
      if (!/^\d+$/.test(value)) {
        throw new Error('Cloudflare socket returned an invalid Content-Length')
      }
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || (contentLength !== undefined && contentLength !== parsed)) {
        throw new Error('Cloudflare socket returned an invalid Content-Length')
      }
      contentLength = parsed
      continue
    }
    if (lowerName === 'transfer-encoding') {
      chunked = value.toLowerCase().includes('chunked')
      continue
    }
    if (lowerName === 'connection') {
      continue
    }
    if (lowerName === 'content-encoding') {
      contentEncoding = value.toLowerCase()
      continue
    }
    if (lowerName === 'content-type') {
      headers.set('content-type', value)
    }
  }
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new Error(`Cloudflare socket returned unsupported content encoding ${contentEncoding}`)
  }

  let body = raw.subarray(headerEnd + 4)
  if (chunked) {
    body = decodeChunkedBody(body)
  }
  else if (contentLength !== undefined) {
    if (body.byteLength < contentLength) {
      throw new Error('Cloudflare socket returned a truncated HTTP response')
    }
    body = body.subarray(0, contentLength)
  }

  const responseBody = body.byteLength === 0 ? null : new Uint8Array(body).buffer
  return new Response(responseBody, {
    status,
    statusText,
    headers,
  })
}

function decodeChunkedBody(encoded: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  let offset = 0
  while (offset < encoded.byteLength) {
    const lineEnd = findSequence(encoded, new Uint8Array([13, 10]), offset)
    if (lineEnd === -1) {
      throw new Error('Cloudflare socket returned an invalid chunked response')
    }
    const sizeToken = textDecoder.decode(encoded.subarray(offset, lineEnd)).split(';', 1)[0]?.trim() ?? ''
    if (!/^[0-9a-f]+$/i.test(sizeToken)) {
      throw new Error('Cloudflare socket returned an invalid chunk size')
    }
    const size = Number.parseInt(sizeToken, 16)
    if (!Number.isSafeInteger(size)) {
      throw new Error('Cloudflare socket returned an invalid chunk size')
    }
    offset = lineEnd + 2
    if (size === 0) {
      return concatBytes(chunks, total)
    }
    const chunkEnd = offset + size
    if (chunkEnd + 2 > encoded.byteLength || encoded[chunkEnd] !== 13 || encoded[chunkEnd + 1] !== 10) {
      throw new Error('Cloudflare socket returned a truncated chunked response')
    }
    const chunk = encoded.subarray(offset, chunkEnd)
    chunks.push(chunk)
    total += chunk.byteLength
    offset = chunkEnd + 2
  }
  throw new Error('Cloudflare socket returned an unterminated chunked response')
}

function findSequence(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let index = start; index <= haystack.byteLength - needle.byteLength; index += 1) {
    for (let needleIndex = 0; needleIndex < needle.byteLength; needleIndex += 1) {
      if (haystack[index + needleIndex] !== needle[needleIndex]) {
        continue outer
      }
    }
    return index
  }
  return -1
}

function concatBytes(chunks: Uint8Array[], total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)): Uint8Array {
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}
