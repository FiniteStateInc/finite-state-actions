import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

vi.mock('@actions/core', () => ({ info: vi.fn(), warning: vi.fn() }))

import { useEnvProxy } from '../src/proxy'

/**
 * Proves the dispatcher `useEnvProxy` installs is one Node's built-in `fetch`
 * actually uses — the part that breaks silently if the `undici` dependency and
 * the Node running the action drift apart. Note that undici tunnels with
 * CONNECT even for an http:// target, so the stand-in proxy only needs that.
 */
describe('useEnvProxy end to end', () => {
  const originalDispatcher = getGlobalDispatcher()
  const originalProxy = process.env.HTTP_PROXY
  const servers: http.Server[] = []

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher)
    if (originalProxy === undefined) {
      delete process.env.HTTP_PROXY
    } else {
      process.env.HTTP_PROXY = originalProxy
    }
    for (const server of servers) {
      server.close()
    }
  })

  it('sends fetch traffic through the proxy in the environment', async () => {
    const target = http.createServer((_req, res) => res.end('hello'))
    servers.push(target)
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))

    let connects = 0
    const proxy = http.createServer(() => {})
    proxy.on('connect', (req, clientSocket, head) => {
      connects++
      const [host, port] = req.url!.split(':')
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) {
          upstream.write(head)
        }
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
    })
    servers.push(proxy)
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))

    const proxyPort = (proxy.address() as net.AddressInfo).port
    const targetPort = (target.address() as net.AddressInfo).port
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`
    delete process.env.NO_PROXY
    delete process.env.no_proxy

    expect(useEnvProxy()).toBe(`http://127.0.0.1:${proxyPort}/`)

    const response = await fetch(`http://127.0.0.1:${targetPort}/hi`, {
      signal: AbortSignal.timeout(10_000),
    })

    expect(await response.text()).toBe('hello')
    expect(connects).toBe(1)
  })
})
