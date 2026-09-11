const crypto = require('crypto')
const https = require('https')
const { default: axios } = require('axios')

const BILIBILI_API_ORIGIN = 'https://api.bilibili.com'
const BILIBILI_REFERER = 'https://www.bilibili.com/'
const BILIBILI_SEARCH_REFERER = 'https://search.bilibili.com/'
const BILIBILI_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BILIBILI_REQUEST_TIMEOUT_MS = 10000
const BILIBILI_GATEWAY_CACHE_MAX_ENTRIES = 512
const BILIBILI_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 32,
  maxFreeSockets: 8,
})
const bilibiliGatewayCache = new Map()
const bilibiliGatewayRequests = new Map()

const ALLOWED_API_PATHS = new Set([
  '/x/web-interface/nav',
  '/x/web-interface/wbi/search/type',
  '/x/web-interface/wbi/view',
  '/x/web-interface/view',
  '/x/player/pagelist',
  '/x/player/wbi/playurl',
  '/x/player/playurl',
])

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function bearerToken(request) {
  const authorization = stringValue(request.headers.authorization)
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  return match ? match[1].trim() : ''
}

function secretsMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

function requestURL(request) {
  return new URL(request.originalUrl, 'http://localhost')
}

function gatewayPath(request) {
  const pathname = requestURL(request).pathname
  if (pathname === '/bilibili') return '/'
  return pathname.startsWith('/bilibili/')
    ? pathname.slice('/bilibili'.length)
    : ''
}

function upstreamHeaders(referer, accept) {
  const headers = {
    Accept: accept,
    'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: referer,
    'User-Agent': BILIBILI_USER_AGENT,
  }
  const cookie = stringValue(process.env.BILIBILI_COOKIE)
  if (cookie) headers.Cookie = cookie
  return headers
}

function gatewayCacheTTL(path) {
  if (path === '/x/web-interface/nav') return 6 * 60 * 60 * 1000
  if (path.includes('/search/')) return 10 * 60 * 1000
  if (path.includes('/playurl')) return 2 * 60 * 1000
  return 30 * 60 * 1000
}

function gatewayCacheKey(path, parsedRequestURL) {
  const params = new URLSearchParams(parsedRequestURL.searchParams)
  // WBI signatures change every request while the signed business parameters
  // and their successful JSON response remain cacheable for a short period.
  params.delete('w_rid')
  params.delete('wts')
  params.sort()
  return `${path}?${params.toString()}`
}

function cachedGatewayResponse(key) {
  const cached = bilibiliGatewayCache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    bilibiliGatewayCache.delete(key)
    return null
  }
  bilibiliGatewayCache.delete(key)
  bilibiliGatewayCache.set(key, cached)
  return cached.value
}

function isSuccessfulBilibiliPayload(result, path) {
  if (result.status !== 200) return false
  try {
    const payload = JSON.parse(result.data.toString('utf8'))
    return (
      payload &&
      (payload.code === 0 ||
        (path === '/x/web-interface/nav' && payload.code === -101))
    )
  } catch {
    return false
  }
}

function rememberGatewayResponse(key, value, ttl) {
  bilibiliGatewayCache.delete(key)
  while (bilibiliGatewayCache.size >= BILIBILI_GATEWAY_CACHE_MAX_ENTRIES) {
    const oldestKey = bilibiliGatewayCache.keys().next().value
    if (!oldestKey) break
    bilibiliGatewayCache.delete(oldestKey)
  }
  bilibiliGatewayCache.set(key, {
    value,
    expiresAt: Date.now() + ttl,
  })
}

async function fetchBilibiliAPI(parsedRequestURL, path) {
  const upstreamURL = `${BILIBILI_API_ORIGIN}${path}${parsedRequestURL.search}`
  const referer = path.includes('/search/')
    ? BILIBILI_SEARCH_REFERER
    : BILIBILI_REFERER
  const upstream = await axios({
    method: 'get',
    url: upstreamURL,
    headers: upstreamHeaders(referer, 'application/json, text/plain, */*'),
    responseType: 'arraybuffer',
    timeout: BILIBILI_REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    proxy: false,
    httpsAgent: BILIBILI_HTTPS_AGENT,
    validateStatus: () => true,
  })

  return {
    status: upstream.status,
    contentType:
      upstream.headers['content-type'] || 'application/json; charset=utf-8',
    data: Buffer.from(upstream.data),
  }
}

async function loadBilibiliAPI(parsedRequestURL, path) {
  const cacheKey = gatewayCacheKey(path, parsedRequestURL)
  const cached = cachedGatewayResponse(cacheKey)
  if (cached) return { result: cached, cacheStatus: 'HIT' }

  const pending = bilibiliGatewayRequests.get(cacheKey)
  if (pending) return { result: await pending, cacheStatus: 'COALESCED' }

  const request = fetchBilibiliAPI(parsedRequestURL, path)
  bilibiliGatewayRequests.set(cacheKey, request)
  try {
    const result = await request
    if (isSuccessfulBilibiliPayload(result, path)) {
      rememberGatewayResponse(cacheKey, result, gatewayCacheTTL(path))
    }
    return { result, cacheStatus: 'MISS' }
  } finally {
    if (bilibiliGatewayRequests.get(cacheKey) === request) {
      bilibiliGatewayRequests.delete(cacheKey)
    }
  }
}

async function proxyBilibiliAPI(request, response, path) {
  const { result, cacheStatus } = await loadBilibiliAPI(
    requestURL(request),
    path,
  )

  response.status(result.status)
  response.set('Content-Type', result.contentType)
  response.set('Cache-Control', 'no-store')
  response.set('X-Ahylo-Gateway-Cache', cacheStatus)
  response.send(result.data)
}

function createBilibiliGateway(logger) {
  return async (request, response) => {
    const expectedToken = stringValue(
      process.env.AHYLO_BILIBILI_GATEWAY_TOKEN,
    )
    if (!expectedToken) {
      response.status(503).send({
        code: 503,
        message: 'Bilibili gateway is not configured',
      })
      return
    }
    if (!secretsMatch(bearerToken(request), expectedToken)) {
      response.status(401).send({
        code: 401,
        message: 'Bilibili gateway authorization failed',
      })
      return
    }

    const path = gatewayPath(request)
    if (request.method !== 'GET') {
      response.status(405).send({ code: 405, message: 'Method not allowed' })
      return
    }
    if (!ALLOWED_API_PATHS.has(path)) {
      response.status(404).send({ code: 404, message: 'Route not found' })
      return
    }

    try {
      await proxyBilibiliAPI(request, response, path)
      logger.info(`Bilibili gateway: ${request.method} ${path}`)
    } catch (error) {
      logger.error(`Bilibili gateway failed: ${request.method} ${path}`, {
        message: error instanceof Error ? error.message : 'unknown error',
      })
      if (!response.headersSent) {
        response.status(502).send({
          code: 502,
          message: 'Bilibili gateway upstream request failed',
        })
      } else {
        response.destroy()
      }
    }
  }
}

module.exports = { createBilibiliGateway }
