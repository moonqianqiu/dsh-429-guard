/**
 * dsh-429-guard · 浏览器半冒烟测试（无需浏览器）
 *
 * 桩掉 window / document / react，按真实 ModuleLoader 契约把 bundle 跑起来，
 * 然后：
 *   1. apply(ctx) 必须注册 shell.overlay 条目；
 *   2. 用一份「已开启 + 正在重试 + 有最近错误」的快照渲染一次，
 *      展开卡片的所有分支（含逃生阀、正在退避等待、错误摘要）都要能走通。
 *
 *   node scripts/smoke-client.mjs
 */

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`)
  }
}

/** 版本号以源码里的 VERSION 为准，并与 package.json 对账 —— 升版本不用改测试。 */
import { readFileSync } from 'node:fs'
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const CLIENT_VERSION = (clientSrc.match(/VERSION = '([^']+)'/) || [])[1]
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
check('源码 VERSION 与 package.json 同步', Boolean(CLIENT_VERSION) && CLIENT_VERSION === pkg.version, CLIENT_VERSION + ' vs ' + pkg.version)

// ------------------------------------------------------------------
// window / document 桩
// ------------------------------------------------------------------
const styles = []
const loaded = []
const viewport = { w: 1280, h: 800 }
const listeners = {}
const fetchCalls = []
const rafQueue = []
let elementFromPointImpl = null
globalThis.window = {
  get innerWidth() {
    return viewport.w
  },
  get innerHeight() {
    return viewport.h
  },
  requestAnimationFrame(fn) {
    rafQueue.push(fn)
    return rafQueue.length
  },
  addEventListener(type, fn) {
    ;(listeners[type] = listeners[type] || []).push(fn)
  },
  removeEventListener(type, fn) {
    listeners[type] = (listeners[type] || []).filter((f) => f !== fn)
  },
  __ModuleLoader__: {
    load(opts) {
      loaded.push(opts)
    },
  },
  fetch(url, options) {
    fetchCalls.push({ url, options })
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
  },
}
globalThis.document = {
  querySelector() {
    return null
  },
  elementFromPoint(x, y) {
    return elementFromPointImpl ? elementFromPointImpl(x, y) : null
  },
  createElement(tag) {
    return { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
  },
  head: {
    appendChild(node) {
      styles.push(node)
    },
  },
}

// ------------------------------------------------------------------
// react 桩：createElement + hooks（首个 useState 返回展开态）
// ------------------------------------------------------------------
let hookIndex = 0
const hookOverrides = {}
/** 捕获每次 useEffect 的回调与每个 useRef 的句柄，测试里手动驱动。 */
const effects = []
/** 单独记一份 layout effect：落位必须走它，才能在浏览器绘制前把坐标写好。 */
const layoutEffects = []
const refs = []

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return { type, props: props || {}, children }
}

const React = {
  createElement,
  useState(init) {
    const i = hookIndex
    hookIndex += 1
    if (Object.prototype.hasOwnProperty.call(hookOverrides, i)) return [hookOverrides[i], () => {}]
    return [typeof init === 'function' ? init() : init, () => {}]
  },
  useEffect(fn) {
    effects.push(fn)
  },
  useLayoutEffect(fn) {
    layoutEffects.push(fn)
    effects.push(fn)
  },
  useRef(init) {
    hookIndex += 1
    const ref = { current: init }
    refs.push(ref)
    return ref
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
}

const require = (name) => {
  if (name === 'react') return React
  throw new Error('未预期的依赖: ' + name)
}

console.log('dsh-429-guard client smoke')

// ------------------------------------------------------------------
console.log('\n[1] bundle 装载')
await import('../lib/client.js')
check('调用了 __ModuleLoader__.load', loaded.length === 1, loaded.length)
const bundle = loaded[0]
check('id 正确', bundle.id === 'dsh-429-guard', bundle.id)
check('factory 是函数', typeof bundle.factory === 'function')

const mod = bundle.factory(require)
check('导出 apply', typeof mod.apply === 'function')
check('导出 inject = [slots]', JSON.stringify(mod.inject) === '["slots"]', mod.inject)

// ------------------------------------------------------------------
console.log('\n[2] apply() 注册 shell.overlay')
const registered = []
const ctx = {
  get(name) {
    return name === 'slots' ? {} : undefined
  },
  slots: {
    inject(key, cb) {
      check('inject 键为 shell.overlay', key === 'shell.overlay', key)
      cb()
      return () => {}
    },
    register(spec, component) {
      registered.push({ spec, component })
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
}

mod.apply(ctx)
check('样式已注入', styles.length === 1 && styles[0].tag === 'style')
check('CSS 含胶囊与卡片类', styles[0] && styles[0].textContent.includes('.d429g-pill') && styles[0].textContent.includes('.d429g-card'))
check('注册了浮窗条目', registered.length === 1, registered.length)
check('条目 id 与顺序', registered[0] && registered[0].spec.id === 'dsh-429-guard' && registered[0].spec.order === 9999, registered[0] && registered[0].spec)
check('注册的是组件函数', typeof registered[0].component === 'function')

// ------------------------------------------------------------------
console.log('\n[3] 展开态渲染（开启 + 正在重试 + 最近错误）')
const snapshot = {
  ok: true,
  enabled: true,
  caps: { maxRetries: 3, maxRetryMs: 60000 },
  stats: {
    retriesTotal: 7,
    cappedTotal: 2,
    last429At: new Date().toISOString(),
    lastFailure: {
      at: new Date().toISOString(),
      message: 'Allocated quota exceeded, please increase your quota limit.',
      code: 'QUOTA',
      status: 429,
      provider: 'vsllm',
      turn: 1,
      step: 2,
    },
  },
  active: [{ key: 'vsllm:1:2', retries: 7, startedAt: Date.now() }],
}

hookOverrides[0] = true // open = true
hookOverrides[1] = snapshot // state
// 模拟「首次轮询已回填」后的输入框（真实环境由 poll 的 capsSynced 写入）
hookOverrides[4] = { maxRetries: '3', maxRetryMs: '60' }
hookIndex = 0

const GuardWidget = registered[0].component
const refStart = refs.length
const effectStart = effects.length
let tree
try {
  tree = GuardWidget({})
  check('渲染未抛异常', true)
} catch (err) {
  check('渲染未抛异常', false, err && err.message)
  console.log(err && err.stack)
  process.exit(1)
}

function collect(node, texts) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, texts))
    return
  }
  const savedIndex = hookIndex
  if (typeof node.type === 'function') {
    collect(node.type(node.props || {}), texts)
    hookIndex = savedIndex
    return
  }
  ;(node.children || []).forEach((c) => collect(c, texts))
}

const texts = []
collect(tree, texts)
const joined = texts.join('|')

/** 收集所有满足断言的元素节点（会展开函数组件）。 */
function collectAll(node, pred, out) {
  out = out || []
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    node.forEach((n) => collectAll(n, pred, out))
    return out
  }
  if (typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  const savedIndex = hookIndex
  if (typeof node.type === 'function') {
    collectAll(node.type(node.props || {}), pred, out)
    hookIndex = savedIndex
    return out
  }
  ;(node.children || []).forEach((c) => collectAll(c, pred, out))
  return out
}

const pillNode = collectFind(tree, (n) => n && n.props && String(n.props.className || '').includes('d429g-pill'))
const pillTexts = []
if (pillNode) collect(pillNode, pillTexts)
check('开启态盾牌不再带「429」字样', pillTexts.join('') === '', pillTexts.join(''))
check('卡片标题', joined.includes('429 / 配额守卫'))
check('累计重试显示 7', texts.includes('7'))
check('逃生阀拦截显示 2', texts.includes('2'))
check('最近错误摘要', joined.includes('HTTP 429'))
check('错误正文', joined.includes('Allocated quota exceeded'))
check('正在退避等待条', joined.includes('正在退避等待'))
check('已无 QUOTA 警示条', !joined.includes('配额已耗尽'))
check('已无毛玻璃/着色控件', !joined.includes('毛玻璃') && !joined.includes('玻璃颜色'))

const capInputs = collectAll(tree, (n) => n.props && n.props.className === 'd429g-cap')
check('设防输入框有两个', capInputs.length === 2, capInputs.length)
check('次数回填 3', Boolean(capInputs[0]) && capInputs[0].props.value === '3', capInputs[0] && capInputs[0].props.value)
check('秒数回填 60', Boolean(capInputs[1]) && capInputs[1].props.value === '60', capInputs[1] && capInputs[1].props.value)

// ------------------------------------------------------------------
console.log('\n[4] 收起态渲染（关闭 + 零统计）')
hookOverrides[0] = false
hookOverrides[1] = { ok: true, enabled: false, caps: { maxRetries: null, maxRetryMs: null }, stats: { retriesTotal: 0, cappedTotal: 0, last429At: null, lastFailure: null }, active: [] }
hookOverrides[4] = { maxRetries: '', maxRetryMs: '' }
hookIndex = 0
const idleEffectStart = effects.length
let idle
try {
  idle = GuardWidget({})
  check('收起态渲染未抛异常', true)
} catch (err) {
  check('收起态渲染未抛异常', false, err && err.message)
  check('未渲染卡片', false)
  process.exit(1)
}
const idleTexts = []
collect(idle, idleTexts)
const idleJoined = idleTexts.join('|')
check('未渲染卡片', !idleJoined.includes('429 / 配额守卫'))
check('胶囊计数徽标不显示 0', !idleJoined.includes('0'))
check('无错误行', !idleJoined.includes('最近拦截'))

// ------------------------------------------------------------------
console.log('\n[5] 拖动位移判定')
const pill = collectFind(tree, (n) => n && n.props && n.props.className && String(n.props.className).includes('d429g-pill'))
check('找到胶囊节点', Boolean(pill))
if (pill) {
  const props = pill.props
  check('胶囊有 pointer 事件', typeof props.onPointerDown === 'function' && typeof props.onPointerMove === 'function' && typeof props.onPointerUp === 'function')
  check('胶囊可聚焦', props.type === 'button')
}

function collectFind(node, pred) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = collectFind(n, pred)
      if (hit) return hit
    }
    return null
  }
  if (pred(node)) return node
  const savedIndex = hookIndex
  if (typeof node.type === 'function') {
    const inner = collectFind(node.type(node.props || {}), pred)
    hookIndex = savedIndex
    if (inner) return inner
    return null
  }
  for (const c of node.children || []) {
    const hit = collectFind(c, pred)
    if (hit) return hit
  }
  return null
}

check('已移除「常驻胶囊」开关', !joined.includes('常驻胶囊'))
check('已移除独立「隐藏」按钮（× 即收起）', !joined.includes('隐藏'))
const verNode = collectAll(tree, (n) => n.props && n.props.className === 'd429g-ver')
check('卡片里不再显示版本号（刷新状态改由主机回报确认）', verNode.length === 0 && !joined.includes('429 守卫 v'), verNode.length)
check('版本号样式一并移除', !styles[0].textContent.includes('.d429g-ver'))
check('卡片收窄到 272px、内边距 12px', styles[0].textContent.includes('width: 272px') && styles[0].textContent.includes('padding: 12px 12px 10px'))
check(
  '开启态只有盾牌一个子节点（不再有 429 字样）',
  Boolean(pill) && Array.isArray(pill.children) && pill.children.length === 1,
  pill && pill.children && pill.children.length,
)
const idleMini = collectAll(idle, (n) => n.props && String(n.props.className || '').includes('d429g-mini'))
check('关闭态渲染小点', idleMini.length === 1, idleMini.length)
const idlePill = collectAll(idle, (n) => n.props && String(n.props.className || '').includes('d429g-pill'))
check('关闭态不渲染胶囊', idlePill.length === 0, idlePill.length)
check('卡片不再显示版本号（主机回报里仍有 version 字段）', !joined.includes('429 守卫 v'))
check('胶囊上不再有 tooltip 字样', Boolean(pill) && !pill.props.title)
check('小点首帧带高亮定位类', idleMini.length === 1 && String(idleMini[0].props.className).includes('locate'))
check('小点上不再有 tooltip 字样', idleMini.length === 1 && !idleMini[0].props.title)
check(
  '小点也能拖动（与胶囊同一套指针事件）',
  idleMini.length === 1 &&
    typeof idleMini[0].props.onPointerDown === 'function' &&
    typeof idleMini[0].props.onPointerMove === 'function' &&
    typeof idleMini[0].props.onPointerUp === 'function' &&
    typeof idleMini[0].props.onKeyDown === 'function',
)

console.log('\n[6] 定位：贴右上角，并修正包含块原点')
check('CSS 含小点态', styles[0].textContent.includes('.d429g-mini'))
check('CSS 含首帧高亮规则', styles[0].textContent.includes('.d429g-mini.locate'))
// 开关时图标不许左右跳：两种形态必须是同一个格子、图标都居中（共享同一中心）
const pillKids = (pill && pill.children) || []
check(
  '胶囊里只有盾牌一个子节点',
  pillKids.length === 1 && (typeof pillKids[0].type === 'function' || pillKids[0].type === 'svg'),
  pillKids.map((k) => (k && k.type) || '?').join(','),
)
const dotNode =
  idleMini.length === 1
    ? (idleMini[0].children || []).filter((c) => c && c.props && c.props.className === 'd429g-dot')
    : []
check('关闭态的小点画在同一格里', dotNode.length === 1, dotNode.length)
check(
  '两种形态共用同一格（26×26，图标都居中）',
  styles[0].textContent.includes('.d429g-mini, .d429g-pill { box-sizing: border-box; width: 26px; height: 26px') &&
    styles[0].textContent.includes('display: inline-flex; align-items: center; justify-content: center'),
)
check('图标上不再挂提示字样', !pill.title && idleMini.length === 1 && !idleMini[0].props.title)
check(
  '无障碍名仍然保留',
  Boolean(pill.props['aria-label']) && idleMini.length === 1 && Boolean(idleMini[0].props['aria-label']),
)
check('小点视觉挂在点上，不再挂在按钮上', styles[0].textContent.includes('.d429g-mini:hover .d429g-dot'))
check(
  'CSS 宿主收回指针事件且不再横贯整行',
  styles[0].textContent.includes('width: max-content') && styles[0].textContent.includes('pointer-events: auto'),
)
const hostRef = refs[refStart]
check('拿到宿主 ref', Boolean(hostRef))
const placementEffect = effects[effectStart + 2]
check('捕获到定位 effect', typeof placementEffect === 'function')

const fakeHost = {
  style: {},
  offsetWidth: 150,
  offsetHeight: 34,
  ownerDocument: globalThis.document,
  getBoundingClientRect() {
    // 模拟包含块被祖先带偏：position:fixed 实际参照的盒子原点在视口 (0, 44)
    const left = parseFloat(this.style.left || '0')
    const top = 44 + parseFloat(this.style.top || '0')
    return {
      left: left,
      top: top,
      right: left + this.offsetWidth,
      bottom: top + this.offsetHeight,
      width: this.offsetWidth,
      height: this.offsetHeight,
    }
  },
}
const fakeFace = { offsetWidth: 150, offsetHeight: 34 }
const faceRef = refs[refStart + 6]
check('拿到形态 ref（宽度以形态为准）', Boolean(faceRef))
if (faceRef) faceRef.current = fakeFace
check('定位走 layout effect（绘制前写坐标，换形态才不闪）', layoutEffects.includes(placementEffect))
if (hostRef && placementEffect) {
  hostRef.current = fakeHost
  placementEffect()
  check('贴视口右上角 left', fakeHost.style.left === '1116px', fakeHost.style.left)
  let rect = fakeHost.getBoundingClientRect()
  check('默认落在标题栏安全退让之下（y=82）', rect.top === 82, rect.top)
  check('换算后确实在视口内', rect.left >= 0 && rect.top >= 0 && rect.right <= 1280 && rect.bottom <= 800)
  check('right/bottom 锚点已清空', fakeHost.style.right === 'auto' && fakeHost.style.bottom === 'auto')

  // 顶部那一条被标题栏盖住时，要自己往下让到探针看不见遮挡为止
  const titlebar = { id: 'titlebar' }
  elementFromPointImpl = (x, y) => (y < 150 ? titlebar : null)
  fakeHost.offsetWidth = 151
  fakeFace.offsetWidth = 151 // 形态宽度 = 签名来源，换个宽度逼定位 effect 重跑
  placementEffect()
  rect = fakeHost.getBoundingClientRect()
  check('被标题栏盖住时自动下移', rect.top === 148, rect.top)
  check('让位后探针已不被遮挡', globalThis.document.elementFromPoint(rect.left + 75, rect.top + 17) === null)

  // 同层还压着别的插件的小角标时，也要让开（大层板不算）
  const neighbour = {
    getBoundingClientRect: () => ({ left: 1100, top: 100, right: 1260, bottom: 156, width: 160, height: 56 }),
  }
  fakeHost.parentNode = { children: [fakeHost, neighbour] }
  elementFromPointImpl = () => null
  fakeHost.offsetWidth = 152
  fakeFace.offsetWidth = 152
  placementEffect()
  rect = fakeHost.getBoundingClientRect()
  check('与同层小浮窗重叠时自动下移', rect.top === 170, rect.top)

  // 拖动中不许自动让位：用户正拿着它挑位置，自动挪一下就会「来回闪」
  const dragRef = refs[refStart + 1]
  const savedDrag = dragRef ? dragRef.current : null
  if (dragRef) dragRef.current = { id: 1, startX: 0, startY: 0, originX: 0, originY: 0, moved: true }
  fakeHost.offsetWidth = 152
  fakeFace.offsetWidth = 152
  fakeFace.offsetHeight = 38 // 换签名逼定位 effect 重跑
  placementEffect()
  rect = fakeHost.getBoundingClientRect()
  check('拖动中不再自动让位（用户放哪就是哪）', rect.top === 82, rect.top)
  if (dragRef) dragRef.current = savedDrag
  fakeFace.offsetHeight = 34

  const before = fakeHost.style.left
  placementEffect()
  check('尺寸未变时不再重复写样式', fakeHost.style.left === before)

  // 负向对照：宿主宽度置 0，落位仍要用形态宽度（卡片与 toast 都是绝对定位，不参与宿主宽度）
  fakeHost.offsetWidth = 0
  fakeHost.offsetHeight = 0
  fakeFace.offsetHeight = 35 // 换签名逼重跑
  placementEffect()
  check('落位读形态宽度，不读宿主宽度', fakeHost.style.left === '1114px', fakeHost.style.left)
  fakeHost.offsetWidth = 152
  fakeHost.offsetHeight = 34
  fakeFace.offsetHeight = 34

  const reported = fetchCalls.filter((c) => c.url === '/guard-api/client-report')
  check(
    '落位后把坐标与版本回报给主机',
    reported.length > 0 &&
      String(reported[reported.length - 1].options.body).includes('"version":"' + CLIENT_VERSION + '"') &&
      String(reported[reported.length - 1].options.body).includes('"under"'),
    reported.length,
  )
  check('回报不再带 covered（诊断只留 under，一次探测）', reported.length > 0 && !String(reported[reported.length - 1].options.body).includes('"covered"'))

  // 形态宽度晚一帧才定型（字体 / 子元素布局）：下一帧补量一次，右边缘钉回原位
  rafQueue.length = 0
  fakeHost.offsetWidth = 152
  fakeHost.offsetHeight = 34
  fakeFace.offsetWidth = 152
  fakeFace.offsetHeight = 36 // 换个签名逼定位 effect 重跑
  placementEffect()
  check('按落位当时的宽度贴角', fakeHost.style.left === '1114px', fakeHost.style.left)
  fakeFace.offsetWidth = 158 // 晚一帧才变宽 6px
  const pending = rafQueue.slice()
  check('落位后挂了一帧补量', pending.length === 1, pending.length)
  const reportsBefore = fetchCalls.filter((c) => c.url === '/guard-api/client-report').length
  pending.forEach((fn) => fn())
  check('宽度晚一帧定型时右边缘钉回原位', fakeHost.style.left === '1108px', fakeHost.style.left)
  check(
    '补量后重新回报',
    fetchCalls.filter((c) => c.url === '/guard-api/client-report').length === reportsBefore + 1,
  )
  fakeFace.offsetHeight = 34
}

// ------------------------------------------------------------------
console.log('\n[7] 形态切换时保住右边缘（拖动后胶囊 ↔ 小点）')
hookOverrides[0] = false
hookOverrides[5] = { x: 300, y: 120 }
const refStart2 = refs.length
const effectStart2 = effects.length
hookIndex = 0
let tree2
try {
  tree2 = GuardWidget({})
  check('带拖动位置的渲染未抛异常', true)
} catch (err) {
  check('带拖动位置的渲染未抛异常', false, err && err.message)
  console.log(err && err.stack)
  process.exit(1)
}
const hostRef2 = refs[refStart2]
const place2 = effects[effectStart2 + 2]
check('拿到第二次渲染的宿主与定位 effect', Boolean(hostRef2) && typeof place2 === 'function')
if (hostRef2 && place2) {
  const host2 = {
    style: {},
    offsetWidth: 84, // 胶囊宽
    offsetHeight: 26,
    ownerDocument: globalThis.document,
    getBoundingClientRect() {
      const left = parseFloat(this.style.left || '0')
      const top = 44 + parseFloat(this.style.top || '0')
      return {
        left: left,
        top: top,
        right: left + this.offsetWidth,
        bottom: top + this.offsetHeight,
        width: this.offsetWidth,
        height: this.offsetHeight,
      }
    },
  }
  hostRef2.current = host2
  place2()
  check('拖过的位置原样落位', host2.style.left === '300px' && host2.style.top === '76px', host2.style.left + ',' + host2.style.top)
  const rightBefore = parseFloat(host2.style.left) + host2.offsetWidth
  host2.offsetWidth = 14 // 关掉守卫：变回小点
  host2.offsetHeight = 14
  place2()
  check('变回小点后右边缘不动', parseFloat(host2.style.left) + host2.offsetWidth === rightBefore, host2.style.left)
  check('小点左边缘随之内缩到 370', parseFloat(host2.style.left) === 370, host2.style.left)
}

// ------------------------------------------------------------------
console.log('\n[8] 性能：轮询门控 + 拖动回报节流 + 毛玻璃降档')
check('毛玻璃降档（胶囊/浮标 12px、卡片 14px）', styles[0].textContent.includes('blur(12px)') && styles[0].textContent.includes('blur(14px)'))

// a) 守卫关闭 + 卡片收起：主机状态无从变化，一个请求都不该发
const stateFetchBase = fetchCalls.filter((c) => c.url === '/guard-api/state').length
const idlePoll = effects[idleEffectStart + 3]
check('捕获到收起态轮询 effect', typeof idlePoll === 'function')
idlePoll()
check('守卫关闭且卡片收起时零轮询', fetchCalls.filter((c) => c.url === '/guard-api/state').length === stateFetchBase)

// b) 展开态：标签页不可见时暂停，回到前台立即补一次
const openPoll = effects[effectStart + 3]
check('捕获到展开态轮询 effect', typeof openPoll === 'function')
globalThis.document.hidden = true
const cleanupHidden = openPoll()
check('标签页不可见时不发轮询', fetchCalls.filter((c) => c.url === '/guard-api/state').length === stateFetchBase)
globalThis.document.hidden = false
const cleanupVisible = openPoll()
check('回到前台立即补一次轮询', fetchCalls.filter((c) => c.url === '/guard-api/state').length === stateFetchBase + 1)
if (typeof cleanupHidden === 'function') cleanupHidden()
if (typeof cleanupVisible === 'function') cleanupVisible()

// c) 拖动中不发回报，pointerup 补报最终落点
const reportsBase = fetchCalls.filter((c) => c.url === '/guard-api/client-report').length
const dragRef3 = refs[refStart + 1]
const savedDrag3 = dragRef3 ? dragRef3.current : null
if (dragRef3) dragRef3.current = { id: 1, startX: 0, startY: 0, originX: 0, originY: 0, moved: true }
fakeFace.offsetHeight = 37 // 换签名逼定位 effect 重跑
placementEffect()
check('拖动中落位不再逐帧回报', fetchCalls.filter((c) => c.url === '/guard-api/client-report').length === reportsBase)
const pillForUp = pill || collectFind(tree, (n) => n && n.props && String(n.props.className || '').includes('d429g-pill'))
if (pillForUp && pillForUp.props.onPointerUp) {
  pillForUp.props.onPointerUp({ pointerId: 1, currentTarget: fakeHost })
}
check('拖动结束后补报最终落点', fetchCalls.filter((c) => c.url === '/guard-api/client-report').length === reportsBase + 1)
if (dragRef3) dragRef3.current = savedDrag3
fakeFace.offsetHeight = 34

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)