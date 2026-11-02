/**
 * dsh-429-guard · node half
 *
 * 主机端 Cordis 插件。监听 agent loop 的 `agent/request-error` waterfall，
 * 当开关开启且失败属于「429 / 配额不足」时，退避等待后返回 { kind: 'retry' }
 * 接管恢复；等待过程可被 agent 的 abort signal 取消。
 *
 * 0.2.0 重写要点：
 *   - 无持久化。开关、设防（逃生阀）、统计全是进程内状态，
 *     进程重启即回到「关闭 + 无限重试」，不写任何磁盘文件。
 *   - 判定收窄到 429 / 配额。code ∈ {RATE_LIMIT, QUOTA} || status === 429
 *     || message/code 命中文案正则。文案兜底是必需的：第三方中转站
 *     （OpenAI 兼容网关）常常把配额问题包成 HTTP 400/403，status 抓不到。
 *   - 移除了对 LlmFailure.cause 的兜底遍历 —— 当前类型上不存在该字段。
 *   - 与浏览器半的通道是一条极简同源路由 /guard-api，仅接受本机回环请求。
 */

export const inject = ['webServer']

/** agent loop 在配额/限流场景下抛出的错误 code。 */
const RATE_LIMIT_CODE = 'RATE_LIMIT'
const QUOTA_CODE = 'QUOTA'

/**
 * 文案兜底。第三方中转站的错误体不是 DeepSeek 原文，
 * 常见的表述都在这里覆盖。
 */
const TEXT_429_RE = /\b429\b|\brate[\s_-]?limit\b|\binsufficient[\s_-]+quota\b|\bquota[\s_-]?(?:exceeded|exhausted|reached)\b|\bexceed(?:ed|s)?[\s_-]+(?:your|the)?[\s_-]*(?:current)?[\s_-]*quota\b/i

/** 首次重试延迟。 */
const INITIAL_DELAY_MS = 2000
/** 自算退避的延迟上限。 */
const MAX_DELAY_MS = 60000
/** providerRetryAfterMs 的上限，避免供应商给一个离谱的值把请求挂死。 */
const PROVIDER_RETRY_CAP_MS = MAX_DELAY_MS * 4
/** 退避抖动比例。 */
const JITTER_RATIO = 0.25
/** POST body 上限。 */
const MAX_BODY_BYTES = 65536
/** active 表里判定陈旧的时限，防止陈旧的 key 让浮窗一直转圈。 */
const ACTIVE_TTL_MS = 10 * 60 * 1000
const MAX_ACTIVE_ENTRIES = 512

const ROUTE_PATH = '/guard-api'

/**
 * 进程内初始状态：默认「关闭 + 无限重试」。
 * 刻意不落盘 —— 见文件头说明。
 */
function defaultState() {
  return {
    enabled: false,
    caps: { maxRetries: null, maxRetryMs: null },
    stats: {
      retriesTotal: 0,
      cappedTotal: 0,
      last429At: null,
      lastFailure: null,
    },
  }
}

function nowIso() {
  return new Date().toISOString()
}

/** 把界面传来的逃生阀值规范化：非法或 < min 一律当「无限」。 */
function capValue(value, min) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) return null
  return Math.floor(n)
}

/**
 * 判断一次 LLM 失败是否属于「429 / 配额不足」。
 * 依次看 code、HTTP status、以及文案正则。
 */
function isRateLimited(failure) {
  if (!failure) return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  if (code === RATE_LIMIT_CODE || code === QUOTA_CODE) return true
  if (typeof failure.status === 'number' && failure.status === 429) return true

  const message = typeof failure.message === 'string' ? failure.message : ''
  if (TEXT_429_RE.test(message)) return true
  if (code && TEXT_429_RE.test(code)) return true
  return false
}

/**
 * 计算下一次重试前要等多久。
 * providerRetryAfterMs 优先，其次是指数退避 + 抖动。
 */
function backoffDelayMs(retry, providerRetryAfterMs) {
  if (Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0) {
    return Math.min(Math.floor(providerRetryAfterMs), PROVIDER_RETRY_CAP_MS)
  }
  const base = INITIAL_DELAY_MS * Math.pow(2, Math.max(0, retry - 1))
  const capped = Math.min(base, MAX_DELAY_MS)
  const jitter = capped * JITTER_RATIO
  const value = capped - jitter + Math.random() * jitter * 2
  return Math.max(0, Math.floor(value))
}

/** 可被 abort signal 打断的 sleep。 */
function cancellableDelay(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(false)
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function apply(ctx) {
  const state = defaultState()
  /** 浏览器半回报的浮窗落点 / bundle 版本；纯诊断用，不参与守卫逻辑。 */
  state.client = null
  /**
   * key = `${provider}:${turn}:${step}`
   * value = { retries, capped, startedAt, waiting }
   * 常驻进程内，用于累计同一个 step 上的重试次数（逃生阀计数依据）。
   */
  const active = new Map()

  function pruneActive() {
    const cutoff = Date.now() - ACTIVE_TTL_MS
    for (const [key, entry] of active) {
      if (!entry.waiting && entry.startedAt < cutoff) active.delete(key)
    }
    if (active.size <= MAX_ACTIVE_ENTRIES) return
    const sorted = [...active.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)
    const drop = active.size - MAX_ACTIVE_ENTRIES
    for (let i = 0; i < drop; i += 1) active.delete(sorted[i][0])
  }

  /** 给浏览器半的快照。active 只暴露「正在退避等待」的条目。 */
  function snapshot() {
    pruneActive()
    const waiting = []
    for (const [key, entry] of active) {
      if (!entry.waiting) continue
      waiting.push({ key, retries: entry.retries, startedAt: entry.startedAt })
    }
    return {
      ok: true,
      enabled: state.enabled,
      caps: { ...state.caps },
      stats: { ...state.stats },
      active: waiting,
      client: state.client,
    }
  }

  function activeEntry(key) {
    let entry = active.get(key)
    if (!entry) {
      entry = { retries: 0, capped: false, startedAt: Date.now(), waiting: false }
      active.set(key, entry)
    }
    return entry
  }

  /** 逃生阀：本次请求再怎么等也不该重试了，返回原因或 null。 */
  function capExceeded(entry, nextDelayMs) {
    const { maxRetries, maxRetryMs } = state.caps
    if (maxRetries !== null && entry.retries >= maxRetries) {
      return `已达最大重试次数 ${maxRetries}`
    }
    if (maxRetryMs !== null) {
      const elapsed = Date.now() - entry.startedAt
      if (elapsed + nextDelayMs > maxRetryMs) {
        return `已达最长重试时长 ${maxRetryMs}ms（已用 ${elapsed}ms）`
      }
    }
    return null
  }

  // ------------------------------------------------------------------
  // agent/request-error：核心拦截
  // ------------------------------------------------------------------
  ctx.on('agent/request-error', async (payload, next) => {
    const { failure, provider, turn, step, signal } = payload

    if (!state.enabled) return next()
    if (!isRateLimited(failure)) return next()

    const key = `${provider}:${turn}:${step}`
    const entry = activeEntry(key)
    if (entry.capped) return next()

    const retry = entry.retries + 1
    const delayMs = backoffDelayMs(retry, failure && failure.providerRetryAfterMs)

    const reason = capExceeded(entry, delayMs)
    if (reason) {
      entry.capped = true
      entry.waiting = false
      state.stats.cappedTotal += 1
      ctx.logger?.info?.(`dsh-429-guard: ESCAPE HATCH ${key} — ${reason}，交还控制权`)
      return next()
    }

    state.stats.retriesTotal += 1
    state.stats.last429At = nowIso()
    state.stats.lastFailure = {
      at: nowIso(),
      message: typeof failure.message === 'string' ? failure.message.slice(0, 500) : '',
      code: failure.code || '',
      status: typeof failure.status === 'number' ? failure.status : null,
      provider,
      turn,
      step,
    }

    entry.retries = retry
    entry.waiting = true
    ctx.logger?.info?.(
      `dsh-429-guard: ${key} 第 ${retry} 次重试，等待 ${delayMs}ms（${failure.code || failure.status || 'text-match'}）`,
    )

    const completed = await cancellableDelay(delayMs, signal)
    entry.waiting = false

    if (!completed || (signal && signal.aborted)) {
      ctx.logger?.info?.(`dsh-429-guard: ${key} 等待被中断，交还控制权`)
      return next()
    }

    if (!state.enabled) {
      ctx.logger?.info?.(`dsh-429-guard: ${key} 等待期间守卫被关闭，交还控制权`)
      return next()
    }

    return { kind: 'retry' }
  })

  // ------------------------------------------------------------------
  // /guard-api：与浏览器半的极简同源通道
  // ------------------------------------------------------------------
  function isTrustedApiRequest(req) {
    const addr = req.socket && req.socket.remoteAddress
    const loopback =
      addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    if (!loopback) return false

    const origin = req.headers.origin
    if (!origin) return true
    try {
      const originHost = new URL(origin).host
      return originHost === req.headers.host
    } catch {
      return false
    }
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (!chunks.length) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('invalid json'))
        }
      })
      req.on('error', reject)
    })
  }

  async function handle(req, res) {
    if (!isTrustedApiRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }

    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PATH.length) || '/'
    const method = (req.method || 'GET').toUpperCase()

    try {
      if (method === 'GET' && path === '/state') {
        sendJson(res, 200, snapshot())
        return
      }

      if (method === 'POST' && path === '/enable') {
        const body = await readJsonBody(req)
        state.enabled = body.enabled === true
        ctx.logger?.info?.(`dsh-429-guard: 守卫已${state.enabled ? '开启' : '关闭'}`)
        sendJson(res, 200, snapshot())
        return
      }

      if (method === 'POST' && path === '/caps') {
        const body = await readJsonBody(req)
        state.caps.maxRetries = capValue(body.maxRetries, 1)
        state.caps.maxRetryMs = capValue(body.maxRetryMs, 1000)
        // 设防值变了，已判过「放弃」的 step 重新获得机会。
        for (const entry of active.values()) entry.capped = false
        sendJson(res, 200, snapshot())
        return
      }

      if (method === 'POST' && path === '/reset') {
        state.stats.retriesTotal = 0
        state.stats.cappedTotal = 0
        state.stats.last429At = null
        state.stats.lastFailure = null
        active.clear()
        sendJson(res, 200, snapshot())
        return
      }

      if (method === 'POST' && path === '/client-report') {
        const body = await readJsonBody(req)
        state.client = {
          version: typeof body.version === 'string' ? body.version : null,
          x: Number(body.x),
          y: Number(body.y),
          w: Number(body.w),
          h: Number(body.h),
          vw: Number(body.vw),
          vh: Number(body.vh),
          usedW: Number.isFinite(Number(body.usedW)) ? Number(body.usedW) : null,
          covered: body.covered === true,
          under: typeof body.under === 'string' ? body.under.slice(0, 80) : null,
          at: new Date().toISOString(),
        }
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err && err.message ? err.message : 'bad request',
      })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: handle,
    }),
  )
}