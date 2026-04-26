import type { Server } from 'http'
import { app, net } from 'electron'
import type { Logger } from './RemoteLogger'

const PROXY_HOSTS = [
  { host: 'www.pathofexile.com', official: true },
  { host: 'ru.pathofexile.com', official: true },
  { host: 'pathofexile.tw', official: true },
  { host: 'poe.game.daum.net', official: true },
  { host: 'poe.ninja', official: false },
  { host: 'www.poeprices.info', official: false },
]

export class HttpProxy {
  constructor (
    server: Server,
    logger: Logger
  ) {
    server.addListener('request', (req, res) => {
      if (!req.url?.startsWith('/proxy/')) return
      const host = req.url.split('/', 3)[2]

      try {
        const official = PROXY_HOSTS.find(entry => entry.host === host)?.official
        if (official === undefined) {
          logger.write(`[cors-proxy] reject unwhitelisted host: ${host} (${req.url})`)
          return req.destroy()
        }

        for (const key in req.headers) {
          if (key.startsWith('sec-') || key === 'host' || key === 'origin' || key === 'content-length') {
            delete req.headers[key]
          }
        }

        const proxyReq = net.request({
          url: 'https://' + req.url.slice('/proxy/'.length),
          method: req.method,
          headers: {
            ...req.headers,
            'user-agent': app.userAgentFallback
          },
          useSessionCookies: true,
          referrerPolicy: 'no-referrer-when-downgrade'
        })
        proxyReq.addListener('response', (proxyRes) => {
          try {
            const resHeaders = { ...proxyRes.headers }
            // `net.request` returns an already decoded body
            delete resHeaders['content-encoding']
            const status = proxyRes.statusCode
            const isInteresting = status !== 200 || resHeaders['x-rate-limit-rules']
            if (isInteresting) {
              const rlDump = Object.entries(resHeaders)
                .filter(([k]) => k.startsWith('x-rate-limit-') && k !== 'x-rate-limit-rules' && k !== 'x-rate-limit-policy')
                .map(([k, v]) => `${k.replace('x-rate-limit-', '')}=${v}`)
                .join(' ')
              const retry = resHeaders['retry-after'] ? ` retry-after=${resHeaders['retry-after']}` : ''
              const via = resHeaders['server'] || resHeaders['x-served-by'] || ''
              const viaTag = via ? ` server=${via}` : ''
              logger.write(`[rl] ${status} ${req.url}${retry}${viaTag} ${rlDump}`.trimEnd())
            }
            res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, resHeaders)
            ;(proxyRes as unknown as NodeJS.ReadableStream)
              .on('error', (err) => logger.write(`[cors-proxy] upstream stream error: ${err.message} (${host} ${req.url})`))
              .pipe(res)
          } catch (err) {
            logger.write(`[cors-proxy] response handler threw: ${(err as Error).message} (${host} ${req.url})`)
            res.destroy(err as Error)
          }
        })
        proxyReq.addListener('error', (err) => {
          logger.write(`[cors-proxy] upstream request error: ${err.message} (${host} ${req.url})`)
          res.destroy(err)
        })
        proxyReq.addListener('abort', () => {
          logger.write(`[cors-proxy] upstream request aborted (${host} ${req.url})`)
        })
        req.on('error', (err) => {
          logger.write(`[cors-proxy] client request error: ${err.message} (${host} ${req.url})`)
        })
        res.on('error', (err) => {
          logger.write(`[cors-proxy] client response error: ${err.message} (${host} ${req.url})`)
        })
        req.pipe(proxyReq as unknown as NodeJS.WritableStream)
      } catch (err) {
        logger.write(`[cors-proxy] handler threw: ${(err as Error).message} (${host} ${req.url})`)
        try { res.destroy(err as Error) } catch {}
      }
    })
  }
}
