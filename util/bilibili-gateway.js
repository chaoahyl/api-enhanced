const crypto = require('crypto')
const { default: axios } = require('axios')

const BILIBILI_API_ORIGIN = 'https://api.bilibili.com'
const BILIBILI_REFERER = 'https://www.bilibili.com/'
const BILIBILI_SEARCH_REFERER = 'https://search.bilibili.com/'
const BILIBILI_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BILIBILI_REQUEST_TIMEOUT_MS = 10000

const ALLOWED_API_PATHS = new Set([
  '/x/web-interface/nav',
  '/x/web-interface/wbi/search/type',
  '/x/web-interface/wbi/view',
  '/x/web-interface/view',
  '/x/player/pagelist',
  '/x/player/wbi/playurl',
  '/x/player/playurl',
])

const STREAM_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
]

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

function isAllowedMediaURL(rawURL) {
  try {
    const parsed = new URL(rawURL)
    const hostname = parsed.hostname.toLowerCase()
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      (hostname === 'bilibili.com' ||
        hostname.endsWith('.bilibili.com') ||
        hostname === 'bilivideo.com' ||
        hostname.endsWith('.bilivideo.com') ||
        hostname === 'bilivideo.cn' ||
        hostname.endsWith('.bilivideo.cn') ||
        hostname === 'hdslb.com' ||
        hostname.endsWith('.hdslb.com') ||
        hostname === 'akamaized.net' ||
        hostname.endsWith('.akamaized.net'))
    )
  } catch {
    return false
  }
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

function copyStreamHeaders(response, upstreamHeaders) {
  for (const name of STREAM_RESPONSE_HEADERS) {
    const value = upstreamHeaders[name]
    if (value !== undefined) response.set(name, String(value))
  }
  response.set('Cache-Control', 'no-store')
}

function validateMediaRedirect(options) {
  const nextURL =
    options.href || `${options.protocol}//${options.hostname}${options.path}`
  if (!isAllowedMediaURL(nextURL)) {
    throw new Error('Bilibili media redirect host is not allowed')
  }
  options.headers.Referer = BILIBILI_REFERER
  options.headers['User-Agent'] = BILIBILI_USER_AGENT
}

async function proxyBilibiliAPI(request, response, path) {
  const parsedRequestURL = requestURL(request)
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
    validateStatus: () => true,
  })

  response.status(upstream.status)
  response.set(
    'Content-Type',
    upstream.headers['content-type'] || 'application/json; charset=utf-8',
  )
  response.set('Cache-Control', 'no-store')
  response.send(Buffer.from(upstream.data))
}

async function proxyBilibiliStream(request, response) {
  const rawURL = stringValue(request.query.url)
  if (!isAllowedMediaURL(rawURL)) {
    response.status(400).send({
      code: 400,
      message: 'Bilibili media URL is invalid or not allowed',
    })
    return
  }

  const headers = upstreamHeaders(
    BILIBILI_REFERER,
    stringValue(request.headers.accept) ||
      'audio/mp4, audio/mpeg, audio/*;q=0.9, */*;q=0.8',
  )
  const range = stringValue(request.headers.range)
  if (range) headers.Range = range

  const upstream = await axios({
    method: request.method.toLowerCase(),
    url: rawURL,
    headers,
    responseType: 'stream',
    timeout: BILIBILI_REQUEST_TIMEOUT_MS,
    maxRedirects: 3,
    beforeRedirect: validateMediaRedirect,
    proxy: false,
    validateStatus: () => true,
  })

  response.status(upstream.status)
  copyStreamHeaders(response, upstream.headers)
  if (request.method === 'HEAD') {
    if (upstream.data && typeof upstream.data.destroy === 'function') {
      upstream.data.destroy()
    }
    response.end()
    return
  }
  upstream.data.on('error', () => response.destroy())
  upstream.data.pipe(response)
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
    const isStreamRequest = path === '/stream'
    const methodAllowed = isStreamRequest
      ? request.method === 'GET' || request.method === 'HEAD'
      : request.method === 'GET'
    if (!methodAllowed) {
      response.status(405).send({ code: 405, message: 'Method not allowed' })
      return
    }
    if (!isStreamRequest && !ALLOWED_API_PATHS.has(path)) {
      response.status(404).send({ code: 404, message: 'Route not found' })
      return
    }

    try {
      if (isStreamRequest) {
        await proxyBilibiliStream(request, response)
      } else {
        await proxyBilibiliAPI(request, response, path)
      }
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
