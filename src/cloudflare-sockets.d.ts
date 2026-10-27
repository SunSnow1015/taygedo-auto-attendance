declare module 'cloudflare:sockets' {
  export interface SocketInfo {
    remoteAddress?: string
    localAddress?: string
  }

  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>
    readonly writable: WritableStream<Uint8Array>
    readonly opened: Promise<SocketInfo>
    readonly closed: Promise<void>
    close(): Promise<void>
  }

  export interface SocketAddress {
    hostname: string
    port: number
  }

  export interface SocketOptions {
    secureTransport?: 'off' | 'on' | 'starttls'
    allowHalfOpen: boolean
  }

  export function connect(address: string | SocketAddress, options?: SocketOptions): Socket
}
