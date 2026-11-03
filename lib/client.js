/**
 * dsh-429-guard, browser half.
 *
 * 手写 ModuleLoader bundle（无构建步骤）：注册一个 `shell.overlay` 条目，
 * 在 Web UI 渲染浮窗 —— 盾牌胶囊 + 展开卡片（开关、逃生阀、临时统计）。
 * 胶囊可拖动，**位置不持久化**，刷新即回到右上角。
 * 所有数据经同源 fetch 到 /guard-api（仅 loopback 可信）。
 *
 * 0.2.0 重写要点：
 *   - 移除毛玻璃透明度滑杆、玻璃着色、QUOTA 警示条（官方 shell.quota-notice 已覆盖）。
 *   - 移除三处 localStorage（位置/透明度/着色），零持久化。
 *   - 拖动与点击在 pointer 事件里一次判定，不再用 260ms 延迟区分双击。
 *
 * 0.2.1 要点：
 *   - 静息态收缩成右下角一个小点（12px、25% 透明），只有发生 429 的 15s 内
 *     才自动回到胶囊；也可在卡片里勾「常驻胶囊」。
 *   - 默认位置从左上角改到右下角，并新增视口校正：量出包含块原点后按视口坐标
 *     定位，窗口缩放 / 取消最大化时重新贴边，不会再跑到视口外。
 *   - 宿主 width:max-content + pointer-events:auto —— 原先的块级宿主会横贯整帧，
 *     既挡下面界面的点击，自己也可能被压住看不见。
 *
 * 0.2.10 要点：
 *   - 轮询门控：仅卡片展开（2s）或守卫开启（5s）时轮询；关闭且收起时零请求，
 *     标签页不可见时暂停、回到前台立即补一次。
 *   - 落点回报不再逐帧发：拖动期间跳过，pointerup 补报最终落点。
 *   - 回报只探一次 elementFromPoint（留 under，去掉 covered）。
 *   - 毛玻璃降档（胶囊/浮标 12px、卡片 14px），常驻 GPU 合成开销减半。
 *
 * 0.2.11 要点：
 *   - 新增「重试起点」（默认 2s）与「重试封顶」（默认 32s）两个间隔输入，
 *     留空回默认；逃生阀两行 hint 删除（placeholder 已有 ∞）。
 *   - 「逃生阀拦截」统计更名「放弃重试」。
 */

window.__ModuleLoader__.load({
  id: 'dsh-429-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var createElement = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    /* 落位必须在浏览器绘制之前完成：否则换形态（胶囊 ↔ 小点）时会先按旧坐标画一帧，
       看起来就是小点从一侧闪到另一侧。React 有这个 API，没有就退回 useEffect。 */
    var useLayoutEffect = React.useLayoutEffect || React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    /** 拖动时距视口边缘的最小留白。 */
    var DRAG_EDGE = 12
    /** 超过这个位移就判定为拖动而不是点击。 */
    var DRAG_SLOP = 4
    /** 展开时轮询间隔。 */
    var POLL_OPEN_MS = 2000
    /** 收起时轮询间隔。 */
    var POLL_IDLE_MS = 5000
    /** 「最近拦截」高亮窗口。 */
    var RECENT_WINDOW_MS = 10 * 60 * 1000
    /** 默认贴边留白（用户要「往右一点点」，16 → 14）。 */
    var HOST_MARGIN = 14
    /**
     * 顶部安全退让。桌面端窗口顶部那一条常被标题栏 / 窗口控件占着，
     * 浮窗贴太顶就会「渲染了、看不见、也点不到」——默认先往下让一截。
     * （82px = 让开标题栏与顶部工具按钮，又不至于挂得太下面；压着谁仍由落位探针兜底。）
     */
    var SAFE_TOP_INSET = 82
    /** 万一还是被别的东西盖着，就按这个步长继续往下让，最多让这么多步。 */
    var COVER_STEP = 22
    var COVER_MAX_STEPS = 8
    /** 首帧落位后高亮多久（毫秒）。 */
    var LOCATE_MS = 2400
    /** 客户端版本，与 package.json 同步；挂在 tooltip 上，方便确认页面刷新是否生效。 */
    var VERSION = '0.2.11'

    var API_BASE = '/guard-api'

    var CSS = [
      /* 宿主。浮窗层是全帧点击穿透的，条目必须自己把指针事件收回来；
         width:max-content 让宿主盒只覆盖自己，不会横贯整行挡住下面的界面。
         默认贴右上角 —— 左下角被输入框占着，底边容易被面板压住。
        这里的 right/top 只是 CSS 兜底：实际坐标由 JS 量出包含块原点后写成 left/top。 */
      '.d429g-host { position: fixed; right: 16px; top: 16px; width: max-content;',
      '  pointer-events: auto; z-index: 2147483600;',
      '  font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif); }',
      '.d429g-host.d429g-dragging { cursor: grabbing; user-select: none; }',

      /* ---------- 一个图标、两种状态：同一格、同一中心 ----------
         两种形态都是 26×26 的格子、图标居中，于是小点与盾牌共享同一个中心点，
         开关、拖动都不会让图标挪窝（原先「右边缘贴角」在换形态时会横move几十像素）。 */
      '.d429g-mini, .d429g-pill { box-sizing: border-box; width: 26px; height: 26px; padding: 0;',
      '  display: inline-flex; align-items: center; justify-content: center; touch-action: none; }',
      '.d429g-mini { border: none; background: transparent; cursor: pointer; }',
      '.d429g-mini:focus-visible { outline: none; }',
      '.d429g-dot { width: 12px; height: 12px; border-radius: 50%; opacity: .55;',
      '  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #9ca3af) 85%, transparent);',
      '  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.16)) 70%, transparent);',
      '  transition: opacity .18s ease, transform .18s ease, background .18s ease; }',
      '.d429g-mini:hover .d429g-dot, .d429g-mini:focus-visible .d429g-dot { opacity: 1; transform: scale(1.2); }',
      /* 首帧落位后亮一下：这枚小点平时很淡，总得让人先看见它在哪 */
      '.d429g-mini.locate .d429g-dot { opacity: 1; transform: scale(1.7);',
      '  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 28%, transparent); }',
      '@media (prefers-reduced-motion: reduce) { .d429g-mini.locate .d429g-dot { transform: none; } }',

      /* ---------- 开启态：同一格 + 一层底色（单盾牌，不带字数）---------- */
      '.d429g-pill { border-radius: 50%; cursor: grab;',
      '  background: color-mix(in srgb, var(--dsw-alias-bg-overlay, #ffffff) 82%, transparent);',
      '  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.12)) 70%, transparent);',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 18px rgba(0,0,0,0.10);',
      '  backdrop-filter: blur(12px) saturate(150%); -webkit-backdrop-filter: blur(12px) saturate(150%);',
      '  color: var(--dsw-alias-label-primary, #111827);',
      '  transition: box-shadow .18s ease, border-color .18s ease, transform .18s ease; }',
      '.d429g-pill:hover { transform: translateY(-1px);',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 10px 24px rgba(0,0,0,0.14); }',
      '.d429g-pill:active { transform: translateY(0); }',
      '.d429g-pill:focus-visible { outline: none;',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 24%, transparent); }',
      '.d429g-pill svg { display: block; }',

      '.d429g-pill.on { border-color: color-mix(in srgb, #22c55e 42%, transparent); }',
      '.d429g-pill.on svg { color: #22c55e; }',
      '.d429g-pill.retrying { border-color: color-mix(in srgb, #f59e0b 55%, transparent);',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), 0 0 0 3px rgba(245,158,11,0.14); }',
      '.d429g-pill.retrying svg { color: #f59e0b;',
      '  animation: d429g-pulse 1.4s ease-in-out infinite; }',
      '@keyframes d429g-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }',

      /* ---------- 卡片 ---------- */
      '.d429g-card { position: absolute; top: calc(100% + 8px); right: 0; width: 272px;',
      '  border-radius: 14px; padding: 12px 12px 10px; box-sizing: border-box;',
      '  background: color-mix(in srgb, var(--dsw-alias-bg-overlay, #ffffff) 88%, transparent);',
      '  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.12)) 70%, transparent);',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), 0 18px 44px rgba(0,0,0,0.18);',
      '  backdrop-filter: blur(14px) saturate(160%); -webkit-backdrop-filter: blur(14px) saturate(160%);',
      '  color: var(--dsw-alias-label-primary, #111827); animation: d429g-in .16s ease; }',
      '.d429g-card.up { top: auto; bottom: calc(100% + 8px); }',
      '@keyframes d429g-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',

      '.d429g-hero { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 9px; }',
      '.d429g-title { font-size: 12.5px; font-weight: 700; letter-spacing: .2px; }',
      '.d429g-sub { margin-top: 2px; font-size: 10.5px; line-height: 1.45;',
      '  color: var(--dsw-alias-label-tertiary, #6b7280); }',
      '.d429g-x { margin-left: auto; flex: none; width: 20px; height: 20px; border: none; border-radius: 6px;',
      '  display: flex; align-items: center; justify-content: center; cursor: pointer;',
      '  background: transparent; color: var(--dsw-alias-label-tertiary, #6b7280); }',
      '.d429g-x:hover { background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)) 70%, transparent); }',

      '.d429g-row { display: flex; align-items: center; gap: 8px; padding: 6px 0;',
      '  border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.08)) 60%, transparent); }',
      '.d429g-label { font-size: 12px; }',
      '.d429g-hint { font-size: 10px; margin-top: 1px; color: var(--dsw-alias-label-tertiary, #9ca3af); }',
      '.d429g-spacer { margin-left: auto; display: flex; align-items: center; gap: 6px; }',

      /* 开关 */
      '.d429g-toggle { position: relative; width: 38px; height: 22px; flex: none; border-radius: 999px;',
      '  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.14)) 70%, transparent);',
      '  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.08)) 70%, transparent);',
      '  cursor: pointer; padding: 0; transition: background .18s ease, border-color .18s ease; }',
      '.d429g-toggle:disabled { opacity: .5; cursor: default; }',
      '.d429g-toggle.on { background: var(--dsw-alias-brand-primary, #3b82f6);',
      '  border-color: var(--dsw-alias-brand-primary, #3b82f6); }',
      '.d429g-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;',
      '  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.28); transition: transform .18s ease; }',
      '.d429g-toggle.on .d429g-knob { transform: translateX(16px); }',

      /* 输入 */
      '.d429g-cap { width: 62px; padding: 4px 6px; border-radius: 8px; font-size: 12px;',
      '  font-variant-numeric: tabular-nums; text-align: center;',
      '  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.05)) 55%, transparent);',
      '  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.12)) 55%, transparent);',
      '  color: var(--dsw-alias-label-primary, #111827); box-shadow: inset 0 1px 0 rgba(255,255,255,0.3);',
      '  transition: border-color .15s ease, box-shadow .15s ease; }',
      '.d429g-cap:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #3b82f6);',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 16%, transparent); }',
      '.d429g-unit { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); }',

      /* 统计 */
      '.d429g-stats { margin-top: 3px; padding: 8px 9px; border-radius: 10px;',
      '  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)) 55%, transparent);',
      '  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.08)) 50%, transparent); }',
      '.d429g-kv { display: flex; align-items: baseline; gap: 8px; font-size: 11px; padding: 1.5px 0; }',
      '.d429g-kv .k { color: var(--dsw-alias-label-tertiary, #6b7280); }',
      '.d429g-kv .v { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }',
      '.d429g-err { margin-top: 7px; padding-top: 7px; font-size: 10.5px; line-height: 1.5; word-break: break-word;',
      '  color: var(--dsw-alias-label-secondary, #6b7280);',
      '  border-top: 1px dashed color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.1)) 70%, transparent); }',
      '.d429g-err code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);',
      '  font-size: 10px; padding: 1px 4px; border-radius: 4px;',
      '  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06)) 70%, transparent); }',

      /* 正在重试 */
      '.d429g-live { display: flex; align-items: center; gap: 7px; margin-top: 6px; padding: 6px 9px;',
      '  border-radius: 9px; font-size: 11px;',
      '  color: #b45309; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.28); }',
      '.d429g-spin { width: 12px; height: 12px; flex: none; border-radius: 50%;',
      '  border: 2px solid rgba(245,158,11,0.28); border-top-color: #f59e0b;',
      '  animation: d429g-spin .8s linear infinite; }',
      '@keyframes d429g-spin { to { transform: rotate(360deg); } }',

      '.d429g-foot { display: flex; gap: 6px; margin-top: 9px; }',
      '.d429g-btn { flex: 1; height: 27px; border-radius: 8px; cursor: pointer;',
      '  font-size: 11.5px; font-weight: 600; border: 1px solid transparent;',
      '  background: var(--dsw-alias-brand-primary, #3b82f6); color: #fff;',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 2px 6px color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 30%, transparent);',
      '  transition: filter .15s ease, transform .15s ease; }',
      '.d429g-btn:hover:not(:disabled) { filter: brightness(1.06); transform: translateY(-1px); }',
      '.d429g-btn:active:not(:disabled) { transform: translateY(0); }',
      '.d429g-btn:disabled { opacity: .5; cursor: default; }',
      '.d429g-btn.ghost { background: transparent; color: var(--dsw-alias-label-secondary, #374151);',
      '  border-color: color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.14)) 70%, transparent); box-shadow: none; }',
      '.d429g-btn.ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)) 70%, transparent); }',

      '.d429g-toast { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 1; white-space: nowrap;',
      '  padding: 8px 14px; border-radius: 999px; font-size: 11.5px; font-weight: 600;',
      '  background: color-mix(in srgb, var(--dsw-alias-bg-overlay, #fff) 86%, transparent);',
      '  color: var(--dsw-alias-label-primary, #111827);',
      '  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,0.14)) 70%, transparent);',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 8px 24px rgba(0,0,0,0.14);',
      '  backdrop-filter: blur(12px) saturate(160%); -webkit-backdrop-filter: blur(12px) saturate(160%);',
      '  animation: d429g-toastin .22s ease; }',
      '@keyframes d429g-toastin { from { opacity: 0; transform: translateY(6px); }',
      '  to { opacity: 1; transform: translateY(0); } }',

      /* 暗色 */
      '[data-ds-dark-theme] .d429g-pill, [data-ds-dark-theme] .d429g-card, [data-ds-dark-theme] .d429g-toast {',
      '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 18px 44px rgba(0,0,0,0.5); }',
      '[data-ds-dark-theme] .d429g-knob { background: #f9fafb; }',
    ].join('\n')

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------
    function apiFetch(path, options) {
      return window.fetch(API_BASE + path, options).then(function (res) {
        return res.json()
      })
    }

    function fmtTime(iso) {
      if (!iso) return '—'
      var d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '—'
      var hh = String(d.getHours()).padStart(2, '0')
      var mm = String(d.getMinutes()).padStart(2, '0')
      var ss = String(d.getSeconds()).padStart(2, '0')
      return hh + ':' + mm + ':' + ss
    }

    function fmtCount(value) {
      return typeof value === 'number' && value > 0 ? String(value) : '0'
    }

    function ShieldIcon() {
      return createElement(
        'svg',
        { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        createElement('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }),
      )
    }

    function CloseIcon() {
      return createElement(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 2.4, strokeLinecap: 'round' },
        createElement('path', { d: 'M18 6 6 18M6 6l12 12' }),
      )
    }

    function Toggle(props) {
      return createElement(
        'button',
        {
          className: 'd429g-toggle' + (props.on ? ' on' : ''),
          onClick: props.onToggle,
          disabled: props.disabled,
          role: 'switch',
          'aria-checked': props.on ? 'true' : 'false',
          'aria-label': props.label,
          type: 'button',
        },
        createElement('span', { className: 'd429g-knob' }),
      )
    }

    // ------------------------------------------------------------------
    // 主组件
    // ------------------------------------------------------------------
    function GuardWidget() {
      var [open, setOpen] = useState(false)
      var [state, setState] = useState(null)
      var [toast, setToast] = useState('')
      var [busy, setBusy] = useState(false)
      var [capInput, setCapInput] = useState({ maxRetries: '', maxRetryMs: '', baseDelaySec: '', maxDelaySec: '' })
      var [pos, setPos] = useState(null)
      var [dragging, setDragging] = useState(false)
      /** 视口尺寸：定位与卡片展开方向都跟着它走。 */
      var [vp, setVp] = useState(function () {
        return { w: window.innerWidth, h: window.innerHeight }
      })
      /** 首次落位后短暂高亮：帮用户找到这枚平时几乎隐身的小点。 */
      var [locating, setLocating] = useState(true)

      var hostRef = useRef(null)
      var dragState = useRef(null)
      var capsSynced = useRef(false)
      var toastTimer = useRef(null)
      var placedSig = useRef('')
      /** 上次落位时的宽度：形态在胶囊(宽) 与 小点(窄) 之间切换时，用它保住右边缘。 */
      var widthRef = useRef(0)
      /** 形态元素（小点 / 胶囊）。宽度以它为准 —— 卡片与 toast 都是绝对定位，不参与宿主宽度。 */
      var faceRef = useRef(null)

      /** 守卫开关状态。声明在 effect 之前，轮询门控的依赖数组要取它。 */
      var enabled = Boolean(state && state.enabled)

      var showToast = useCallback(function (text) {
        setToast(text)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(function () {
          setToast('')
        }, 2600)
      }, [])

      useEffect(function () {
        return function () {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        }
      }, [])

      // 视口尺寸跟随窗口。位置不记忆，所以缩放时只做「重新贴边」。
      useEffect(function () {
        function onResize() {
          setVp({ w: window.innerWidth, h: window.innerHeight })
        }
        if (typeof window.addEventListener !== 'function') return undefined
        window.addEventListener('resize', onResize)
        return function () {
          window.removeEventListener('resize', onResize)
        }
      }, [])

      // 定位：每次都按「期望的视口坐标」重算并修正包含块原点。
      // 这样即使浮窗层的 fixed 被祖先的 transform 改写、或窗口尺寸变化，
      // 浮窗也不会跑到视口外面（原先的 top:14px / right:16px 就是栽在这上面）。
      // 用 layout effect：坐标必须在绘制前写好，「换形态时闪一下」才不会发生。
      useLayoutEffect(function () {
        var el = hostRef.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return
        var p = desiredXY()
        var f = faceRef.current
        var sig = p.x + ':' + p.y + ':' + ((f && f.offsetWidth) || el.offsetWidth) + ':' + ((f && f.offsetHeight) || el.offsetHeight)
        if (placedSig.current === sig) return
        placedSig.current = sig
        placeHost(el, p.x, p.y)
        // 拖动中每个 pointermove 都会走到这里：逐帧 POST 回报纯属浪费，
        // 结束时由 onPillPointerUp 补报最终落点。
        if (!dragState.current) reportRect(el)
        // 形态宽度有可能晚一帧才定型（字体、子元素布局），下一帧再量一次把右边缘钉回去。
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(function () { settleFace(el) })
        }
      })

      // 轮询门控：展开时 2s，开启但收起时 5s；关闭且收起时主机状态无从变化，
      // 一个请求都不发（开关/设防只能从这张卡片改，重试只发生在开启态）。
      // 标签页不可见时暂停，回到前台立即补一次。
      useEffect(function () {
        if (!open && !enabled) return undefined
        var alive = true
        function poll() {
          apiFetch('/state')
            .then(function (next) {
              if (!alive || !next || next.ok === false) return
              setState(next)
              if (!capsSynced.current) {
                capsSynced.current = true
                setCapInput({
                  maxRetries: next.caps && next.caps.maxRetries !== null ? String(next.caps.maxRetries) : '',
                  maxRetryMs: next.caps && next.caps.maxRetryMs !== null ? String(Math.round(next.caps.maxRetryMs / 1000)) : '',
                  baseDelaySec: Number.isFinite(next.caps && next.caps.baseDelayMs) ? String(Math.round(next.caps.baseDelayMs / 1000)) : '',
                  maxDelaySec: Number.isFinite(next.caps && next.caps.maxDelayMs) ? String(Math.round(next.caps.maxDelayMs / 1000)) : '',
                })
              }
            })
            .catch(function () {})
        }
        var hidden = typeof document !== 'undefined' && document.hidden
        if (!hidden) poll()
        var timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.hidden) return
          poll()
        }, open ? POLL_OPEN_MS : POLL_IDLE_MS)
        function onVisibility() {
          if (typeof document !== 'undefined' && !document.hidden) poll()
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility)
        }
        return function () {
          alive = false
          clearInterval(timer)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }
      }, [open, enabled])

      // 首帧高亮：小点平时压得很淡，进页面时亮一下，让人一眼看到它落在哪。
      useEffect(function () {
        var t = setTimeout(function () { setLocating(false) }, LOCATE_MS)
        return function () { clearTimeout(t) }
      }, [])

      var stats = (state && state.stats) || {}
      var activeList = (state && state.active) || []
      var retrying = activeList.length > 0
      var retries = stats.retriesTotal || 0
      var capped = stats.cappedTotal || 0
      var lastFailure = stats.lastFailure || null
      var last429 = stats.last429At || null
      var recent = last429 ? Date.now() - new Date(last429).getTime() < RECENT_WINDOW_MS : false
      /** 形态判定：开启守卫 = 小胶囊（盾牌 + 429）；关闭 = 一枚小点。 */
      var guardOn = Boolean(enabled)

      function clampXY(x, y) {
        var el = hostRef.current
        var w = el ? el.offsetWidth : 26
        var h = el ? el.offsetHeight : 26
        var maxX = Math.max(DRAG_EDGE, vp.w - w - DRAG_EDGE)
        var maxY = Math.max(DRAG_EDGE, vp.h - h - DRAG_EDGE)
        return {
          x: Math.min(Math.max(DRAG_EDGE, x), maxX),
          y: Math.min(Math.max(DRAG_EDGE, y), maxY),
        }
      }

      /** 期望的视口坐标：没拖过就贴右上角（顶部留出标题栏的安全退让），拖过就用拖到的点位。 */
      function desiredXY() {
        var el = hostRef.current
        var f = faceRef.current
        var w = (f && f.offsetWidth) || (el && el.offsetWidth) || 26
        if (pos) {
          // 形态换了宽窄（胶囊 ↔ 小点）时保住「右边缘」不动：
          // 否则小点会跳到胶囊的左边缘去，看起来像自己跑偏了。
          var prev = widthRef.current
          var keep = prev && w && prev !== w ? prev - w : 0
          return clampXY(pos.x + keep, pos.y)
        }
        return clampXY(vp.w - w - HOST_MARGIN, SAFE_TOP_INSET)
      }

      /**
       * 量出「包含块原点」：position:fixed 只有在祖先没有 transform / filter /
       * perspective 时才以视口为参照。先归零量一次，就知道它实际参照谁了。
       */
      function containingOrigin(el) {
        var s = el.style
        var prev = { left: s.left, top: s.top, right: s.right, bottom: s.bottom, visibility: s.visibility }
        s.visibility = 'hidden'
        s.left = '0px'
        s.top = '0px'
        s.right = 'auto'
        s.bottom = 'auto'
        var rect = el.getBoundingClientRect()
        s.left = prev.left
        s.top = prev.top
        s.right = prev.right
        s.bottom = prev.bottom
        s.visibility = prev.visibility
        var bx = Number(rect.left)
        var by = Number(rect.top)
        if (!isFinite(bx)) bx = 0
        if (!isFinite(by)) by = 0
        return { x: bx, y: by }
      }

      function placeHost(el, x, y) {
        var base = containingOrigin(el)
        var f = faceRef.current
        widthRef.current = (f && f.offsetWidth) || el.offsetWidth || 0
        el.style.left = Math.round(x - base.x) + 'px'
        el.style.top = Math.round(y - base.y) + 'px'
        el.style.right = 'auto'
        el.style.bottom = 'auto'
        // 兜底：万一包含块原点量错，按实测矩形把浮窗拽回视口内，绝不留在看不见的地方。
        if (typeof el.getBoundingClientRect !== 'function') return
        var r = el.getBoundingClientRect()
        var dx = 0
        var dy = 0
        if (r.left < DRAG_EDGE) dx = DRAG_EDGE - r.left
        else if (r.right > vp.w - DRAG_EDGE) dx = vp.w - DRAG_EDGE - r.right
        if (r.top < DRAG_EDGE) dy = DRAG_EDGE - r.top
        else if (r.bottom > vp.h - DRAG_EDGE) dy = vp.h - DRAG_EDGE - r.bottom
        if (dx || dy) {
          var nextLeft = parseFloat(el.style.left)
          var nextTop = parseFloat(el.style.top)
          if (isFinite(nextLeft)) el.style.left = Math.round(nextLeft + dx) + 'px'
          if (isFinite(nextTop)) el.style.top = Math.round(nextTop + dy) + 'px'
        }
        // 兜底二：落在视口内 ≠ 看得见。窗口顶部那一条常被标题栏 / 窗口控件盖住。
        // 拖动中不插手：那会儿是用户自己在挑位置，别把人刚放好的东西又挪走。
        if (!dragState.current) nudgeOutOfCover(el)
      }

      /**
       * 落位后补量一次：形态（盾牌格 / 小点格）的宽度若比落位当时量到的多几像素，
       * 右边缘就会离角差一截。只在宽度确实变了时补一次，不重排、不多跑。
       */
      function settleFace(el) {
        var f = faceRef.current
        if (!el || !f) return
        var wNow = f.offsetWidth || 0
        var wUsed = widthRef.current
        if (!wNow || !wUsed || wNow === wUsed) return
        var p = desiredXY()
        placeHost(el, p.x, p.y)
        if (!dragState.current) reportRect(el)
      }

      /** 这个点上最上层的是不是别人？（是别人 = 我们被盖住了） */
      function coveredAt(doc, el, rect) {
        var px = rect.left + (rect.width || 0) / 2
        var py = rect.top + (rect.height || 0) / 2
        if (!isFinite(px) || !isFinite(py)) return false
        var hit = null
        try { hit = doc.elementFromPoint(px, py) } catch (err) { return false }
        if (!hit || hit === el) return false
        if (typeof el.contains === 'function' && el.contains(hit)) return false
        if (typeof hit.contains === 'function' && hit.contains(el)) return false
        return true
      }

      /**
       * 同层还有别的浮窗（比如别的插件的角标）时，别跟它挤在同一格。
       * 只把小体积的算邻居；横贯整屏的层板（toast 栈之类）忽略不计。
       */
      function overlapsNeighbour(el, rect) {
        var parent = el.parentNode
        if (!parent || !parent.children || typeof parent.children.length !== 'number') return false
        var areaLimit = (vp.w * vp.h) / 3
        for (var i = 0; i < parent.children.length; i++) {
          var sib = parent.children[i]
          if (sib === el || typeof sib.getBoundingClientRect !== 'function') continue
          var r = sib.getBoundingClientRect()
          var w = r.width || 0
          var h = r.height || 0
          if (w <= 1 || h <= 1) continue
          if (w > 480 || h > 240 || w * h > areaLimit) continue
          if (rect.left < r.right && rect.right > r.left && rect.top < r.bottom && rect.bottom > r.top) return true
        }
        return false
      }

      /**
       * 被盖住 / 跟别人挤在一起就往下让。桌面端窗口顶部那条（标题栏 / 最小化最大化
       * 关闭）压在浮窗层上面时，浮窗就是「渲染了、看不见、也点不到」。我们没法预知
       * 那层有多高，就直接问浏览器「这个点最上面的是谁」，一步步往下挪到露出来为止。
       */
      function nudgeOutOfCover(el) {
        var doc = el.ownerDocument
        var canProbe = Boolean(doc && typeof doc.elementFromPoint === 'function')
        for (var i = 0; i < COVER_MAX_STEPS; i++) {
          var r = el.getBoundingClientRect()
          var busy = (canProbe && coveredAt(doc, el, r)) || overlapsNeighbour(el, r)
          if (!busy) return
          var nextTop = parseFloat(el.style.top)
          if (!isFinite(nextTop)) return
          if (r.top + COVER_STEP + (r.height || 0) > vp.h) return
          el.style.top = Math.round(nextTop + COVER_STEP) + 'px'
        }
      }

      /**
       * 我们压着谁？正常探针永远命中自己（z-index 太高），所以临时让出指针事件
       * 再探一次、立刻恢复——用来回答「是不是正好压在某个按钮上」。
       */
      function whoIsUnder(el) {
        var doc = el.ownerDocument
        if (!doc || typeof doc.elementFromPoint !== 'function') return ''
        var r = el.getBoundingClientRect()
        var prev = el.style.pointerEvents
        el.style.pointerEvents = 'none'
        var hit = null
        try {
          hit = doc.elementFromPoint(Math.round(r.left + (r.width || 0) / 2), Math.round(r.top + (r.height || 0) / 2))
        } catch (err) {
          hit = null
        }
        el.style.pointerEvents = prev
        if (!hit || hit === el) return ''
        var tag = String(hit.tagName || '').toLowerCase()
        var cls = String((hit.className && hit.className.baseVal) || hit.className || '')
        return (tag + (cls ? '.' + cls : '')).slice(0, 80)
      }

      /**
       * 把浮窗最终落在哪报回主机（GET /guard-api/state 的 client 字段）。
       * 目的很实在：在拿不到 devtools 的环境里，定位问题只能靠浏览器自己说话。
       * 只在两个时机发：落位签名变化时、拖动结束时 —— 拖动过程绝不逐帧发。
       */
      function reportRect(el) {
        if (typeof el.getBoundingClientRect !== 'function') return
        var r = el.getBoundingClientRect()
        apiFetch('/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: VERSION,
            x: Math.round(r.left),
            y: Math.round(r.top),
            w: Math.round(r.width || 0),
            h: Math.round(r.height || 0),
            usedW: Math.round(widthRef.current || 0),
            vw: vp.w,
            vh: vp.h,
            under: whoIsUnder(el),
          }),
        }).catch(function () {})
      }

      function onPillPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return
        var rect = e.currentTarget.getBoundingClientRect()
        dragState.current = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          originX: rect.left,
          originY: rect.top,
          moved: false,
        }
        setDragging(true)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch (err) { /* 忽略：部分环境不支持指针捕获 */ }
      }

      function onPillPointerMove(e) {
        var d = dragState.current
        if (!d || d.id !== e.pointerId) return
        var dx = e.clientX - d.startX
        var dy = e.clientY - d.startY
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) d.moved = true
        if (!d.moved) return
        e.preventDefault()
        setPos(clampXY(d.originX + dx, d.originY + dy))
      }

      function onPillPointerUp(e) {
        var d = dragState.current
        if (!d || d.id !== e.pointerId) return
        var moved = d.moved
        dragState.current = null
        setDragging(false)
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch (err) { /* 忽略 */ }
        if (moved) {
          // 拖动期间不发回报，结束时把最终落点补报一次。
          if (hostRef.current) reportRect(hostRef.current)
        } else {
          setOpen(function (v) { return !v })
        }
      }

      function onPillKeyDown(e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault()
          setOpen(function (v) { return !v })
        }
      }

      function toggle() {
        if (busy) return
        setBusy(true)
        apiFetch('/enable', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !enabled }),
        })
          .then(function (next) {
            if (next && next.ok !== false) {
              setState(next)
              // 开关结果在形态（小点 ↔ 胶囊）和卡片副标题上已经写明，不再弹 toast 挡视线。
            } else {
              showToast('操作失败')
            }
          })
          .catch(function () { showToast('操作失败') })
          .then(function () { setBusy(false) })
      }

      function saveCaps() {
        if (busy) return
        setBusy(true)
        var maxRetriesRaw = capInput.maxRetries.trim()
        var maxRetryMsRaw = capInput.maxRetryMs.trim()
        var baseDelayRaw = capInput.baseDelaySec.trim()
        var maxDelayRaw = capInput.maxDelaySec.trim()
        apiFetch('/caps', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            maxRetries: maxRetriesRaw === '' ? null : Number(maxRetriesRaw),
            maxRetryMs: maxRetryMsRaw === '' ? null : Number(maxRetryMsRaw) * 1000,
            baseDelayMs: baseDelayRaw === '' ? null : Number(baseDelayRaw) * 1000,
            maxDelayMs: maxDelayRaw === '' ? null : Number(maxDelayRaw) * 1000,
          }),
        })
          .then(function (next) {
            if (next && next.ok !== false) {
              setState(next)
              setCapInput({
                maxRetries: next.caps.maxRetries !== null ? String(next.caps.maxRetries) : '',
                maxRetryMs: next.caps.maxRetryMs !== null ? String(Math.round(next.caps.maxRetryMs / 1000)) : '',
                baseDelaySec: Number.isFinite(next.caps.baseDelayMs) ? String(Math.round(next.caps.baseDelayMs / 1000)) : '',
                maxDelaySec: Number.isFinite(next.caps.maxDelayMs) ? String(Math.round(next.caps.maxDelayMs / 1000)) : '',
              })
              capsSynced.current = true
              showToast('设防已更新')
            } else {
              showToast('设防无效')
            }
          })
          .catch(function () { showToast('操作失败') })
          .then(function () { setBusy(false) })
      }

      function resetStats() {
        if (busy) return
        setBusy(true)
        apiFetch('/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(function (next) {
            if (next && next.ok !== false) {
              setState(next)
              showToast('统计已清零')
            }
          })
          .catch(function () { showToast('操作失败') })
          .then(function () { setBusy(false) })
      }

      var wantY = pos ? pos.y : SAFE_TOP_INSET
      var dropUp = wantY > vp.h * 0.5

      var pillClass = 'd429g-pill' + (retrying ? ' retrying' : ' on')

      var mini = createElement('button', {
        className: 'd429g-mini' + (locating ? ' locate' : ''),
        type: 'button',
        ref: faceRef,
        'aria-label': '429 守卫（未开启）· 点击展开，拖动可移动',
        onPointerDown: onPillPointerDown,
        onPointerMove: onPillPointerMove,
        onPointerUp: onPillPointerUp,
        onPointerCancel: onPillPointerUp,
        onKeyDown: onPillKeyDown,
      }, createElement('span', { className: 'd429g-dot' }))

      var pill = createElement(
        'button',
        {
          className: pillClass,
          type: 'button',
          ref: faceRef,
          'aria-label': '429 守卫（已开启）· 点击展开，拖动可移动',
          onPointerDown: onPillPointerDown,
          onPointerMove: onPillPointerMove,
          onPointerUp: onPillPointerUp,
          onPointerCancel: onPillPointerUp,
          onKeyDown: onPillKeyDown,
        },
        createElement(ShieldIcon),
      )

      var face = guardOn ? pill : mini

      var card = !open ? null : createElement(
        'div',
        { className: 'd429g-card' + (dropUp ? ' up' : '') },
        createElement(
          'div',
          { className: 'd429g-hero' },
          createElement(
            'div',
            null,
            createElement('div', { className: 'd429g-title' }, '429 / 配额守卫'),
            createElement('div', { className: 'd429g-sub' },
              enabled
                ? '已开启：遇到 429 / 配额不足会自动退避重试'
                : '已关闭：错误按默认行为直接失败'
            ),
          ),
          createElement('button', { className: 'd429g-x', onClick: function () { setOpen(false) }, title: '收起', type: 'button' },
            createElement(CloseIcon)),
        ),

        createElement(
          'div',
          { className: 'd429g-row' },
          createElement('div', null,
            createElement('div', { className: 'd429g-label' }, '自动重试'),
            createElement('div', { className: 'd429g-hint' }, '只拦 429 / 配额不足，其他错误不碰'),
          ),
          createElement('div', { className: 'd429g-spacer' },
            createElement(Toggle, { on: enabled, onToggle: toggle, disabled: busy, label: '自动重试' })),
        ),

        createElement(
          'div',
          { className: 'd429g-row' },
          createElement('div', null,
            createElement('div', { className: 'd429g-label' }, '最多重试'),
          ),
          createElement('div', { className: 'd429g-spacer' },
            createElement('input', {
              className: 'd429g-cap',
              value: capInput.maxRetries,
              placeholder: '∞',
              inputMode: 'numeric',
              onChange: function (e) { setCapInput(function (p) { return Object.assign({}, p, { maxRetries: e.target.value }) }) },
            }),
            createElement('span', { className: 'd429g-unit' }, '次'),
          ),
        ),

        createElement(
          'div',
          { className: 'd429g-row' },
          createElement('div', null,
            createElement('div', { className: 'd429g-label' }, '最长等待'),
          ),
          createElement('div', { className: 'd429g-spacer' },
            createElement('input', {
              className: 'd429g-cap',
              value: capInput.maxRetryMs,
              placeholder: '∞',
              inputMode: 'numeric',
              onChange: function (e) { setCapInput(function (p) { return Object.assign({}, p, { maxRetryMs: e.target.value }) }) },
            }),
            createElement('span', { className: 'd429g-unit' }, '秒'),
          ),
        ),

        createElement(
          'div',
          { className: 'd429g-row' },
          createElement('div', null,
            createElement('div', { className: 'd429g-label' }, '重试起点'),
          ),
          createElement('div', { className: 'd429g-spacer' },
            createElement('input', {
              className: 'd429g-cap',
              value: capInput.baseDelaySec,
              placeholder: '2',
              inputMode: 'decimal',
              onChange: function (e) { setCapInput(function (p) { return Object.assign({}, p, { baseDelaySec: e.target.value }) }) },
            }),
            createElement('span', { className: 'd429g-unit' }, '秒'),
          ),
        ),

        createElement(
          'div',
          { className: 'd429g-row' },
          createElement('div', null,
            createElement('div', { className: 'd429g-label' }, '重试封顶'),
          ),
          createElement('div', { className: 'd429g-spacer' },
            createElement('input', {
              className: 'd429g-cap',
              value: capInput.maxDelaySec,
              placeholder: '10',
              inputMode: 'decimal',
              onChange: function (e) { setCapInput(function (p) { return Object.assign({}, p, { maxDelaySec: e.target.value }) }) },
            }),
            createElement('span', { className: 'd429g-unit' }, '秒'),
          ),
        ),

        createElement(
          'div',
          { className: 'd429g-stats' },
          createElement('div', { className: 'd429g-kv' },
            createElement('span', { className: 'k' }, '累计重试'),
            createElement('span', { className: 'v' }, fmtCount(retries)),
          ),
          createElement('div', { className: 'd429g-kv' },
            createElement('span', { className: 'k' }, '放弃重试'),
            createElement('span', { className: 'v' }, fmtCount(capped)),
          ),
          createElement('div', { className: 'd429g-kv' },
            createElement('span', { className: 'k' }, '最近拦截'),
            createElement('span', { className: 'v', style: recent ? { color: '#f59e0b' } : null }, fmtTime(last429)),
          ),
          lastFailure
            ? createElement(
                'div',
                { className: 'd429g-err', title: lastFailure.message || '' },
                createElement('code', null,
                  (lastFailure.status ? 'HTTP ' + lastFailure.status : (lastFailure.code || 'ERROR'))),
                lastFailure.message ? ' ' + lastFailure.message : '',
              )
            : null,
        ),

        retrying
          ? createElement('div', { className: 'd429g-live' },
              createElement('span', { className: 'd429g-spin' }),
              createElement('span', null,
                '正在退避等待 · ' + (activeList[0].key || '') + ' · 第 ' + activeList[0].retries + ' 次'),
            )
          : null,

        createElement(
          'div',
          { className: 'd429g-foot' },
          createElement('button', { className: 'd429g-btn', onClick: toggle, disabled: busy, type: 'button' },
            busy ? '处理中…' : (enabled ? '关闭守卫' : '开启守卫')),
          createElement('button', { className: 'd429g-btn ghost', onClick: saveCaps, disabled: busy, type: 'button' }, '应用设防'),
          createElement('button', { className: 'd429g-btn ghost', onClick: resetStats, disabled: busy || (!retries && !capped), type: 'button' }, '清零'),
        ),

        )

      return createElement(
        'div',
        {
          className: 'd429g-host' + (dragging ? ' d429g-dragging' : ''),
          ref: hostRef,
        },
        face,
        card,
        toast ? createElement('div', { className: 'd429g-toast' }, toast) : null,
      )
    }

    function apply(ctx) {
      // 注入样式（生命周期随插件 fiber）。
      var tagId = 'dsh-429-guard/guard.css'
      if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + tagId + '"]')) {
        var tag = document.createElement('style')
        tag.setAttribute('data-plugin', 'dsh-429-guard')
        tag.setAttribute('data-plugin-css', tagId)
        tag.textContent = CSS
        document.head.appendChild(tag)
      }

      var slots = ctx.get('slots')
      if (slots === undefined) return
      ctx.effect(function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-429-guard', order: 9999, label: '429 守卫' },
            GuardWidget,
          )
        })
      }, '429-guard: register shell.overlay float widget')
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})