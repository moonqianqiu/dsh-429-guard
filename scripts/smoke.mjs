/**
 * dsh-429-guard · 主机半冒烟测试
 *
 * 不依赖 DSH 运行时：用一个假的 cordis ctx 把 apply() 挂起来，
 * 然后直接触发 agent/request-error 与 /guard-api 路由。
 *
 *   node scripts/smoke.mjs
 */
import { EventEmitter } from 'node:events'
import { apply } from '../lib/index.js'

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`)
  }
}

function boot() {
  const listeners = {}
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, fn) {
      listeners[name] = fn
      return () => delete listeners[name]
    },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx)

  const route = routes.find((r) => r.kind === 'prefix' && r.path === '/guard-api')
  if (!route) throw new Error('未注册 /guard-api 路由')

  function request(method, path, body, opts) {
    opts = opts || {}
    const req = new EventEmitter()
    req.method = method
    req.url = '/guard-api' + path
    req.socket = { remoteAddress: opts.remoteAddress || '127.0.0.1' }
    req.headers = { host: '127.0.0.1:3648' }
    if (opts.origin) req.headers.origin = opts.origin
    const res = {
      code: null,
      headers: null,
      body: '',
      writeHead(code, headers) { this.code = code; this.headers = headers },
      end(text) { this.body = text || '' },
    }
    const done = new Promise((resolve) => {
      res.end = (text) => { res.body = text || ''; resolve(res) }
      process.nextTick(() => {
        if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
        req.emit('end')
      })
    })
    route.handler(req, res)
    return done.then((r) => ({ code: r.code, json: r.body ? JSON.parse(r.body) : null }))
  }

  return {
    listeners,
    fire(payload, next) {
      const fn = listeners['agent/request-error']
      if (!fn) throw new Error('未注册 agent/request-error 监听器')
      return fn(payload, next || (async () => 'NEXT'))
    },
    request,
  }
}

/** boot() + 打开守卫：默认是无持久化的「关闭」态，重试相关的用例都得先武装。 */
async function armed() {
  const app = boot()
  const res = await app.request('POST', '/enable', { enabled: true })
  if (!res.json.enabled) throw new Error('守卫未能开启')
  return app
}

function payload(over) {
  return {
    agent: { id: 'sess-1' },
    turn: 1,
    step: 1,
    provider: 'vsllm',
    failure: { message: 'boom', code: 'SERVER_ERROR' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...over,
  }
}

console.log('dsh-429-guard smoke')

// ------------------------------------------------------------------
console.log('\n[1] 默认态')
{
  const app = boot()
  const res = await app.request('GET', '/state')
  check('GET /state → 200', res.code === 200, res.code)
  check('默认关闭（无持久化）', res.json.enabled === false, res.json.enabled)
  check('默认无逃生阀', res.json.caps.maxRetries === null && res.json.caps.maxRetryMs === null, res.json.caps)
  check('默认统计为 0', res.json.stats.retriesTotal === 0 && res.json.stats.cappedTotal === 0)
}

// ------------------------------------------------------------------
console.log('\n[2] 非 429 一律放行')
{
  const app = await armed()
  const out = await app.fire(payload({ failure: { message: 'internal error', code: 'SERVER_ERROR', status: 500 } }))
  check('500 放行', out === 'NEXT', out)
  const st = await app.request('GET', '/state')
  check('未计入统计', st.json.stats.retriesTotal === 0, st.json.stats)
}

// ------------------------------------------------------------------
console.log('\n[3] status 429 接管重试')
{
  const app = await armed()
  const out = await app.fire(payload({ failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 5 } }))
  check('返回 retry', out && out.kind === 'retry', out)
  const st = await app.request('GET', '/state')
  check('retriesTotal = 1', st.json.stats.retriesTotal === 1, st.json.stats)
  check('最近拦截已记录', typeof st.json.stats.last429At === 'string')
}

// ------------------------------------------------------------------
console.log('\n[4] 第三方中转站：HTTP 400 + insufficient_quota 文案兜底')
{
  const app = await armed()
  const out = await app.fire(payload({
    failure: {
      message: '{"error":{"message":"Allocated quota exceeded, please increase your quota limit.","code":"insufficient_quota"}}',
      code: 'INVALID_REQUEST',
      status: 400,
    },
    signal: AbortSignal.timeout(5000),
  }))
  // 无 providerRetryAfterMs → 走 2s 起步的指数退避，这里只验证它最终给出 retry
  check('文案命中 → retry', out && out.kind === 'retry', out)
}

// ------------------------------------------------------------------
console.log('\n[5] 逃生阀：maxRetries = 1')
{
  const app = await armed()
  await app.request('POST', '/caps', { maxRetries: 1, maxRetryMs: null })
  const first = await app.fire(payload({ failure: { message: 'quota', code: 'QUOTA', providerRetryAfterMs: 1 } }))
  check('第 1 次仍重试', first && first.kind === 'retry', first)
  const second = await app.fire(payload({ failure: { message: 'quota', code: 'QUOTA', providerRetryAfterMs: 1 } }))
  check('第 2 次被逃生阀拦下', second === 'NEXT', second)
  const st = await app.request('GET', '/state')
  check('cappedTotal = 1', st.json.stats.cappedTotal === 1, st.json.stats)
  check('caps 已回读', st.json.caps.maxRetries === 1, st.json.caps)
  const third = await app.fire(payload({ failure: { message: 'quota', code: 'QUOTA', providerRetryAfterMs: 1 } }))
  check('同一 step 不再重试', third === 'NEXT', third)
}

// ------------------------------------------------------------------
console.log('\n[6] 关闭开关即放行')
{
  const app = await armed()
  const armedHit = await app.fire(payload({ failure: { message: 'quota', code: 'QUOTA', providerRetryAfterMs: 1 } }))
  check('开启时确实接管', armedHit && armedHit.kind === 'retry', armedHit)
  await app.request('POST', '/enable', { enabled: false })
  const out = await app.fire(payload({ turn: 2, failure: { message: 'quota', code: 'QUOTA' } }))
  check('关闭后放行', out === 'NEXT', out)
  const st = await app.request('GET', '/state')
  check('关闭态快照', st.json.enabled === false)
}

// ------------------------------------------------------------------
console.log('\n[7] abort signal 取消等待')
{
  const app = await armed()
  const ac = new AbortController()
  ac.abort()
  const out = await app.fire(payload({
    failure: { message: 'quota', code: 'QUOTA', providerRetryAfterMs: 3000 },
    signal: ac.signal,
  }))
  check('已 abort → 放行（不等满 3s）', out === 'NEXT', out)
}

// ------------------------------------------------------------------
console.log('\n[8] 统计清零')
{
  const app = await armed()
  await app.fire(payload({ failure: { message: 'quota', code: 'QUOTA', providerRetryAfterMs: 1 } }))
  const before = await app.request('GET', '/state')
  check('清零前有计数', before.json.stats.retriesTotal === 1, before.json.stats)
  const after = await app.request('POST', '/reset', {})
  check('清零后归零', after.json.stats.retriesTotal === 0 && after.json.stats.last429At === null, after.json.stats)
}

// ------------------------------------------------------------------
console.log('\n[9] 路由与鉴权')
{
  const app = boot()
  const notFound = await app.request('GET', '/nope')
  check('未知路径 404', notFound.code === 404, notFound.code)
  const denied = await app.request('GET', '/state', undefined, { remoteAddress: '10.0.0.8' })
  check('非 loopback 403', denied.code === 403, denied.code)
  const cross = await app.request('GET', '/state', undefined, { origin: 'http://evil.example' })
  check('跨源 Origin 403', cross.code === 403, cross.code)
  const same = await app.request('GET', '/state', undefined, { origin: 'http://127.0.0.1:3648' })
  check('同源 Origin 放行', same.code === 200, same.code)
  const badCaps = await app.request('POST', '/caps', { maxRetries: -5, maxRetryMs: 10 })
  check('非法设防降级为无限', badCaps.json.caps.maxRetries === null && badCaps.json.caps.maxRetryMs === null, badCaps.json.caps)
  const report = await app.request('POST', '/client-report', {
    version: '0.2.9', x: 1114, y: 86, w: 23, h: 26, vw: 1280, vh: 800, covered: false,
    usedW: 19,
    under: 'button.dsh-topbar-btn',
  })
  check('client-report 接受浏览器回报', report.code === 200 && report.json.ok === true, report.code)
  const withClient = await app.request('GET', '/state')
  check(
    '快照带浏览器落点（排查定位用）',
    withClient.json.client && withClient.json.client.version === '0.2.9' &&
      withClient.json.client.x === 1114 && withClient.json.client.y === 86 &&
      withClient.json.client.usedW === 19 &&
      withClient.json.client.under === 'button.dsh-topbar-btn' &&
      typeof withClient.json.client.at === 'string',
    withClient.json.client,
  )
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)