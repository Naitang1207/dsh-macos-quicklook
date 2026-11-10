/**
 * Quick Look 预览 —— Host 半。
 *
 * 浏览器半送来「哪个文件、卡片在哪、窗口在哪」，这里把授权坐标换成 Host 绝对路径
 * （和 DSH 自己的 `api/present.open` 走同一套校验：Session 事件 → workspaceFiles.stat），
 * 再把命令写进常驻 helper 的 stdin。
 *
 * helper 是自绘的 AppKit 面板，里面装系统的 QLPreviewView，所以位置、尺寸、
 * 出现动画都由我们控制；窗口是 nonactivating 且不能成为 key，点它不会把 DSH 踢到后台。
 * 不用 `qlmanage -p` 的原因是它只会开一个固定尺寸、无动画、抢焦点的独立窗口。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'quicklook'
export const inject = [
  'connection',
  'sessionQuery',
  'sessionController',
  'workspaceFiles',
  'sandboxPolicy',
  'subprocess',
]

/** Host 注册的绝对路由；浏览器半用去掉前导斜杠的文档相对形式。 */
const PREVIEW_PATH = '/api/quicklook.preview'
/** 设置项：浏览器半的交互行为和它是同一份数据，所以放 Host 落盘、客户端经接口读写。 */
const SETTINGS_PATH = '/api/quicklook.settings'
const SETTINGS_FILE = join(homedir(), '.dsh', 'quicklook.json')
const DEFAULT_SETTINGS = {
  /** 鼠标在卡片上停多久才接管焦点（毫秒）。0 = 一进入就接管。 */
  hoverDelay: 500,
  /** 预览关掉后把焦点送回聊天输入框。 */
  focusComposer: true,
  /** 双击整张卡片直接预览（默认只认空格和按钮）。 */
  clickToPreview: false,
}

function loadSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return { ...DEFAULT_SETTINGS, ...(parsed !== null && typeof parsed === 'object' ? parsed : null) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings() }
  if (patch !== null && typeof patch === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in patch) next[key] = patch[key]
    }
  }
  // 收敛取值：改坏的值只会让交互变哑，不会让插件崩。
  const delay = Number(next.hoverDelay)
  next.hoverDelay = Number.isFinite(delay)
    ? Math.min(Math.max(Math.round(delay), 0), 3000)
    : DEFAULT_SETTINGS.hoverDelay
  next.focusComposer = next.focusComposer !== false
  next.clickToPreview = next.clickToPreview === true
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true })
    writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    /* 落盘失败就只在本次运行里生效 */
  }
  return next
}

async function handleSettings(request) {
  if (request.method !== 'POST') return json(loadSettings())
  let patch = null
  try {
    patch = await request.json()
  } catch {
    patch = null
  }
  return json(saveSettings(patch))
}
/** 自绘预览面板；随包发布，已经编译好。 */
const HELPER_PATH = fileURLToPath(new URL('./helper/qlhelper', import.meta.url))
/** 预览进程的输出留一点用于排错。 */
const OUTPUT_LIMIT = 64 * 1024
/** 详细诊断只在明确启用时记录；错误日志始终尽力保留。 */
const DEBUG = process.env.QL_DEBUG === '1'
const LOG_LIMIT = 1024 * 1024
/** 收到 terminate 后的强杀宽限。 */
const GRACE_MS = 3000
const NUMERIC = /^\d+$/

/** 解析一个非负整数坐标；非法返回 undefined。 */
function coordinate(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  return typeof value === 'string' && NUMERIC.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined
}

/** Session 日志里的文件声明：path 必填，description 可选。 */
function isPresentedFile(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, description } = value
  return (
    typeof path === 'string' &&
    path.trim().length > 0 &&
    (description === undefined || typeof description === 'string')
  )
}

/** `deliverables/presented` 的负载：turn / callId / files。 */
function isPresentedData(value) {
  return typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'files'))
}

/** 只透传校验过的矩形，避免把 NaN 写进 helper。 */
function rect(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const x = Reflect.get(value, 'x')
  const y = Reflect.get(value, 'y')
  const width = Reflect.get(value, 'width')
  const height = Reflect.get(value, 'height')
  const finite = (n) => typeof n === 'number' && Number.isFinite(n)
  if (![x, y, width, height].every(finite)) return undefined
  return { x, y, width, height }
}

function text(status, message) {
  return new Response(message, {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  })
}

function json(value) {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

/** 把卡片坐标解析成 Host 绝对路径；失败返回 undefined。 */
async function resolvePath(ctx, sessionId, seq, index, signal) {
  const read = await ctx.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, signal)
  const { target, session } = read
  const file =
    target?.type === 'deliverables/presented' && isPresentedData(target.data)
      ? target.data.files[index]
      : undefined
  if (!isPresentedFile(file)) return undefined
  signal.throwIfAborted()
  const stat = await ctx.workspaceFiles.stat(
    { sessionId, workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot },
    file.path,
    signal,
  )
  return typeof stat?.absolutePath === 'string' ? stat.absolutePath : undefined
}

export function apply(ctx) {
  /** 常驻 helper 句柄；null 表示还没起来或者已经退出。 */
  let helper = null
  /** helper 的 stdin；写一行 JSON 就是一条命令。 */
  let input = null
  let disposed = false
  let requestSequence = 0
  let latestPreviewRequest = 0

  /** 说清 helper 为什么起不来，别让用户只看到一句 "not available"。 */
  function helperDiagnosis() {
    try {
      const stat = statSync(HELPER_PATH)
      if (!stat.isFile()) return `helper 不是普通文件：${HELPER_PATH}`
      if ((stat.mode & 0o111) === 0) return `helper 没有执行权限，执行 chmod +x "${HELPER_PATH}"`
      return `helper 存在但无法启动（可能是 CPU 架构不符，需要 arm64 / x86_64 的 macOS 12+）：${HELPER_PATH}`
    } catch {
      return `helper 缺失：${HELPER_PATH}。重新安装插件即可，或在该目录执行 swiftc -O main.swift -o qlhelper 自行编译`
    }
  }

  function ensureHelper() {
    if (disposed) return null
    if (helper !== null) return helper
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [HELPER_PATH],
        cwd: '/',
        stdio: {
          stdin: 'pipe',
          stdout: { maxBytes: OUTPUT_LIMIT },
          stderr: { maxBytes: OUTPUT_LIMIT },
        },
        graceMs: GRACE_MS,
      })
    } catch (error) {
      // 二进制缺失／没有执行权限：让调用方拿到"不可用"，而不是一个 500。
      logLine(`spawn failed ${String(error)} | ${helperDiagnosis()}`, true)
      return null
    }
    helper = handle
    input = handle.stdin ?? null
    // 管道断开时 Writable 是异步发 'error' 事件，send() 里的 try/catch 接不住。
    if (input !== null && typeof input.once === 'function') {
      input.once('error', () => {
        try {
          handle.terminate()
        } catch {
          /* 已经退出 */
        }
        if (helper === handle) {
          helper = null
          input = null
        }
      })
    }
    const forget = () => {
      if (helper === handle) {
        helper = null
        input = null
      }
    }
    handle.done.then(forget, forget)
    return handle
  }

  /** 给 helper 写一条命令；返回是否写成功。 */
  function send(payload) {
    if (ensureHelper() === null) return false
    if (input === null || typeof input.write !== 'function') return false
    try {
      input.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch {
      // 管道断了：把可能还活着的旧进程收掉，避免泄漏成孤儿。
      try {
        helper?.terminate()
      } catch {
        /* 已经退出 */
      }
      helper = null
      input = null
      return false
    }
  }

  function logLine(text, error = false) {
    if (!DEBUG && !error) return
    try {
      const dir = join(homedir(), '.dsh', 'logs')
      const path = join(dir, 'quicklook-host.log')
      const data = Buffer.from(`${Date.now()} ${text}\n`).subarray(0, LOG_LIMIT)
      mkdirSync(dir, { recursive: true })
      let size = 0
      try {
        size = statSync(path).size
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      // 单条超长日志也截断，当前文件与唯一备份都不超过上限。
      if (size > LOG_LIMIT) {
        truncateSync(path, LOG_LIMIT)
        size = LOG_LIMIT
      }
      if (size + data.length > LOG_LIMIT) renameSync(path, `${path}.1`)
      appendFileSync(path, data, { mode: 0o600 })
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  async function handlePreview(request) {
    const sequence = ++requestSequence
    const started = DEBUG ? Date.now() : 0
    if (DEBUG) {
      let seen = null
      try {
        seen = await request.clone().json()
      } catch {
        seen = null
      }
      logLine(`in ${JSON.stringify(seen)}`)
    }
    let response
    try {
      response = await handlePreviewInner(request, sequence)
    } catch (error) {
      // 任何没预期的异常都要落成响应，否则日志里只剩半截、排查时看不见这条请求。
      if (request.signal.aborted) return text(499, 'Cancelled.')
      logLine(`fail ${String(error)}`, true)
      response = text(500, 'Preview failed.')
    }
    if (DEBUG || response.status >= 500) {
      logLine(`out status=${response.status}${DEBUG ? ` ms=${Date.now() - started}` : ''}`, response.status >= 500)
    }
    return response
  }

  async function handlePreviewInner(request, sequence) {
    let body
    try {
      body = await request.json()
    } catch {
      return text(400, 'Body must be JSON.')
    }
    if (typeof body !== 'object' || body === null) return text(400, 'Body must be an object.')

    if (disposed || request.signal.aborted) return text(499, 'Cancelled.')
    const action = body.action
    if (action !== undefined && !['hide', 'focus', 'toggle', 'show'].includes(action)) {
      return text(400, 'Unknown action.')
    }
    if (action === 'hide') {
      if (sequence < latestPreviewRequest) return text(499, 'Superseded.')
      latestPreviewRequest = sequence
      return json({ hidden: send({ cmd: 'hide' }) })
    }
    if (!ctx.sessionController.workspaceDesktop().available) {
      return text(409, 'Host desktop unavailable.')
    }
    if (action === 'focus') return json({ focused: send({ cmd: 'focus' }) })

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const seq = coordinate(body.seq)
    const index = coordinate(body.index)
    if (sessionId.length === 0 || seq === undefined || index === undefined) {
      return text(400, 'Invalid Quick Look coordinates.')
    }
    const requestId = sequence
    if (requestId < latestPreviewRequest) return text(499, 'Superseded.')
    latestPreviewRequest = requestId

    let absolutePath
    try {
      absolutePath = await resolvePath(ctx, sessionId, seq, index, request.signal)
    } catch (error) {
      // 用户切会话／刷新页面会 abort 这个请求：正常收场，不要抛出去（抛出去会变成 500）。
      if (request.signal.aborted) return text(499, 'Cancelled.')
      return text(404, `Presented file unavailable: ${String(error)}`)
    }
    if (disposed || request.signal.aborted) return text(499, 'Cancelled.')
    if (requestId !== latestPreviewRequest) return text(499, 'Superseded.')
    if (absolutePath === undefined) return text(404, 'Presented file not found in this Session result.')

    // toggle 由 helper 判定：它才是唯一知道面板此刻开没开的地方。
    const command = body.action === 'toggle' ? 'toggle' : 'show'
    const shown = send({
      cmd: command,
      path: absolutePath,
      bounds: rect(body.bounds),
      anchor: rect(body.anchor),
    })
    if (!shown) return text(503, `Preview helper is not available. ${helperDiagnosis()}`)
    return json({ previewing: true, path: absolutePath })
  }

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: SETTINGS_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => handleSettings(request),
      }),
    'quicklook: /api/quicklook.settings',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: PREVIEW_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handlePreview(request),
      }),
    'quicklook: POST /api/quicklook.preview',
  )

  // 预热：桌面可用时先把 helper 拉起来，第一次按空格不用等进程启动。
  try {
    if (ctx.sessionController.workspaceDesktop().available) ensureHelper()
  } catch {
    /* 没有桌面就等第一次预览再说 */
  }

  // 插件卸载或禁用时：让 helper 自己收尾，然后兜底杀掉。
  ctx.effect(() => () => {
    disposed = true
    latestPreviewRequest = ++requestSequence
    if (input !== null && typeof input.write === 'function') {
      try {
        input.write(`${JSON.stringify({ cmd: 'quit' })}\n`)
      } catch {
        /* helper 已经走了 */
      }
    }
    try {
      helper?.terminate()
    } catch {
      /* 同上 */
    }
    helper = null
    input = null
  })
}
