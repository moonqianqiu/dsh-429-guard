/**
 * dsh-429-guard · node half
 *
 * 主机端 Cordis 插件。监听 agent loop 的 `agent/request-error` waterfall，
 * 当开关开启且失败属于「429 / 配额不足」时，退避等待后返回 { kind: 'retry' }
 * 接管恢复；等待过程可被 agent 的 abort signal 取消。
 *
 * 0.2.0 重写要点：零持久化（进程内状态，重启即回默认）；判定收窄到
 *   429/配额（code/status/文案正则——中转站常把配额问题包成 400/403，文案兜底必需）；
 *   移除 LlmFailure.cause 兜底遍历；与浏览器半走极简同源路由 /guard-api（仅回环）。
 *
 * 0.2.13 要点：删除 /client-report 路由与快照 client 字段（落位诊断探针已整体移除）。
 *
 * 0.2.11 要点：退避改为分档锯齿缓坡（起点 ×1.5^k 爬到封顶回起点循环，
 *   <4s 连试 3 次、4–6s 连试 2 次）；caps 可调 baseDelayMs/maxDelayMs，留空回默认。
 */

export const inject = ['webServer']

/** agent loop 在配额/限流场景下抛出的错误 code。 */
const RATE_LIMIT_CODE = 'RATE_LIMIT'
const QUOTA_CODE = 'QUOTA'

/**
 * 文案兜底，覆盖第三方中转站的常见表述。刻意不含裸「429」数字：
 * 消息里碰巧出现 429 字样不该触发重试，真正的 429 由 code / status 负责。
 */
const TEXT_429_RE = /\brate[\s_-]?limit\b|\binsufficient[\s_-]+quota\b|\bquota[\s_-]?(?:exceeded|exhausted|reached)\b|\bexceed(?:ed|s)?[\s_-]+(?:your|the)?[\s_-]*(?:current)?[\s_-]*quota\b/i

/** 重试间隔起点（默认），界面可调。 */
const DEFAULT_BASE_DELAY_MS = 2000
/** 重试间隔封顶（默认），界面可调。 */
const DEFAULT_MAX_DELAY_MS = 10000
/** 界面可调的间隔下限。 */
const MIN_BASE_DELAY_MS = 500
/** providerRetryAfterMs 的上限，避免供应商给一个离谱的值把请求挂死（随封顶值走）。 */
const PROVIDER_RETRY_CAP_RATIO = 4
/** 退避抖动比例。 */
const JITTER_RATIO = 0.25
/** POST body 上限。 */
const MAX_BODY_BYTES = 65536
/** active 表里判定陈旧的时限，防止陈旧的 key 让浮窗一直转圈。 */
const ACTIVE_TTL_MS = 10 * 60 * 1000
const MAX_ACTIVE_ENTRIES = 512

const ROUTE_PATH = '/guard-api'

/**
 * 进程内初始状态：默认「关闭 + 无限重试」，刻意不落盘（见文件头）。
 */
function defaultState() {
  return {
    enabled: false,
    caps: {
      maxRetries: null,
      maxRetryMs: null,
      baseDelayMs: DEFAULT_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
    },
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

/** 把界面传来的逃生阀值规范化：非法或低于下限一律当「无限」。 */
function capValue(value, min) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) return null
  return Math.floor(n)
}

/** 判断一次 LLM 失败是否属于 429/配额不足：依次看 code、status、文案正则。 */
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

/** 锯齿缓坡的增长系数：爬到封顶后回到起点循环。 */
const RAMP_RATIO = 1.5
/**
 * 缓坡分档连试：短间隔多试几回合、长间隔不成串。
 * 档位值 < 4s 连试 3 次，< 6s 连试 2 次，其余 1 次。
 */
const RAMP_TIER_FAST_MS = 4000
const RAMP_TIER_SLOW_MS = 6000
const RAMP_REPEATS_FAST = 3
const RAMP_REPEATS_SLOW = 2

/** 某一档延迟该连试几次：<4s 三次，4–6s 两次，更长的一次。 */
function rampRepeats(valueMs) {
  if (valueMs < RAMP_TIER_FAST_MS) return RAMP_REPEATS_FAST
  if (valueMs < RAMP_TIER_SLOW_MS) return RAMP_REPEATS_SLOW
  return 1
}

/**
 * 锯齿缓坡：起点 × 1.5^k 爬到封顶后回到起点循环，每档按 rampRepeats
 * 连试若干次（默认 2s→10s 一轮 10 次约 38s）。
 */
function rampDelayMs(retry, baseDelayMs, maxDelayMs) {
  const steps = Math.max(0, Math.ceil(Math.log(maxDelayMs / baseDelayMs) / Math.log(RAMP_RATIO)))
  let cycle = 0
  for (let k = 0; k <= steps; k += 1) {
    cycle += rampRepeats(Math.min(baseDelayMs * Math.pow(RAMP_RATIO, k), maxDelayMs))
  }
  let n = Math.max(0, retry - 1) % cycle
  for (let k = 0; k <= steps; k += 1) {
    const value = Math.min(baseDelayMs * Math.pow(RAMP_RATIO, k), maxDelayMs)
    const repeats = rampRepeats(value)
    if (n < repeats) return value
    n -= repeats
  }
  return maxDelayMs
}

/** 下一次等多久：providerRetryAfterMs 优先（封顶随 maxDelayMs ×4），否则锯齿缓坡 + 抖动。 */
function backoffDelayMs(retry, providerRetryAfterMs, baseDelayMs, maxDelayMs) {
  if (Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0) {
    return Math.min(Math.floor(providerRetryAfterMs), maxDelayMs * PROVIDER_RETRY_CAP_RATIO)
  }
  const capped = rampDelayMs(retry, baseDelayMs, maxDelayMs)
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
  /**
   * key = `${provider}:${turn}:${step}`，常驻进程内，
   * 用于累计同一 step 的重试次数（逃生阀计数依据）。
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
    const delayMs = backoffDelayMs(
      retry,
      failure && failure.providerRetryAfterMs,
      state.caps.baseDelayMs,
      state.caps.maxDelayMs,
    )

    const reason = capExceeded(entry, delayMs)
    if (reason) {
      entry.capped = true
      entry.waiting = false
      state.stats.cappedTotal += 1
      ctx.logger?.info?.(`dsh-429-guard: ESCAPE HATCH ${key} — ${reason}，交还控制权`)
      return next()
    }

    state.stats.retriesTotal += 1
    const at = nowIso()
    state.stats.last429At = at
    state.stats.lastFailure = {
      at,
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
        // 重新开启 = 重新接管：之前被判过「放弃」的 step 重新获得机会。
        if (state.enabled) {
          for (const entry of active.values()) entry.capped = false
        }
        ctx.logger?.info?.(`dsh-429-guard: 守卫已${state.enabled ? '开启' : '关闭'}`)
        sendJson(res, 200, snapshot())
        return
      }

      if (method === 'POST' && path === '/caps') {
        const body = await readJsonBody(req)
        state.caps.maxRetries = capValue(body.maxRetries, 1)
        state.caps.maxRetryMs = capValue(body.maxRetryMs, 1000)
        // 间隔：留空 = 回到默认；封顶不得低于起点。
        const baseDelayMs = capValue(body.baseDelayMs, MIN_BASE_DELAY_MS) ?? DEFAULT_BASE_DELAY_MS
        const maxDelayMs = capValue(body.maxDelayMs, MIN_BASE_DELAY_MS) ?? DEFAULT_MAX_DELAY_MS
        state.caps.baseDelayMs = baseDelayMs
        state.caps.maxDelayMs = Math.max(maxDelayMs, baseDelayMs)
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