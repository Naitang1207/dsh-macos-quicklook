/**
 * Quick Look 预览 —— 浏览器半。
 *
 * 鼠标停在任何一张交付卡片上（不必停在按钮上）按空格，就把「哪个文件 + 从哪长出来」
 * 发给 Host 半，由常驻 helper 弹出原生预览面板。卡片上的「␣」按钮是同一动作的
 * 鼠标入口，也顺便当"这个卡片可以按空格"的提示。
 *
 * 卡片坐标来自 slot 传进来的 actionUrl；卡片元素只用 `data-presented-file`
 * （宿主自己标在卡片根节点上的属性）做包含判断，不读它的样式、不注入全局样式。
 */
window.__ModuleLoader__.load({
  id: '@naitang1207/dsh-macos-quicklook',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 鼠标当前停住的卡片：{ url, element }（rect 在用的时候现取，滚动后才不会偏）。 */
    let hovered = null
    /**
     * 面板的真实开关状态在 helper 里，浏览器这侧不缓存——因为用户按 Esc 时
     * 面板是系统自己关的，这个页面根本收不到那个事件，本地缓存必然过期
     * （过期后「再按一次空格」会发一个无效的 hide，看起来就是按了没反应）。
     */
    /** 关心 hovered 变化的组件（用来点亮按钮）。 */
    const watchers = new Set()

    function warn(error) {
      console.warn('[quicklook]', error)
    }

    function publish(entry) {
      hovered = entry
      for (const watcher of watchers) {
        try {
          watcher(entry)
        } catch (error) {
          warn(error)
        }
      }
    }

    /** 从卡片的 actionUrl 里取出授权坐标。 */
    function coordinates(actionUrl) {
      if (typeof actionUrl !== 'string' || actionUrl.length === 0) return null
      let parsed
      try {
        parsed = new URL(actionUrl, window.location.href)
      } catch {
        return null
      }
      const sessionId = parsed.searchParams.get('sessionId')
      const seq = parsed.searchParams.get('seq')
      const index = parsed.searchParams.get('index')
      if (sessionId === null || sessionId === '') return null
      // 不能用 Number() 判断空参数：?seq= 会变成合法数字 0，请求发出去才 404。
      if (seq === null || !/^\d+$/.test(seq)) return null
      if (index === null || !/^\d+$/.test(index)) return null
      return { sessionId, seq: Number(seq), index: Number(index) }
    }

    /**
     * 找到鼠标所在元素所属的那张卡片，以及卡片里的 ␣ 按钮。
     * 优先认宿主标在卡片根节点上的 `data-presented-file`；认不到就向上找
     * 第一个"内部只有这一个按钮"的容器（最多 8 层），保证 DSH 换结构时还能用。
     */
    function locate(target, point) {
      if (target === null || typeof target.closest !== 'function') return null
      const card = target.closest('[data-presented-file]')
      if (card !== null) {
        const button = card.querySelector('[data-quicklook-url]')
        if (button !== null) return { button, card }
      }
      let node = target
      let depth = 0
      while (node !== null && node !== document.body && depth < 4) {
        if (typeof node.querySelectorAll === 'function') {
          const buttons = node.querySelectorAll('[data-quicklook-url]')
          if (buttons.length === 1) {
            // 回退路径很容易把「整块消息区」误当成卡片（屏幕上只渲染了一张卡时，
            // 它的祖先也满足"内部只有一个按钮"）。给了鼠标坐标就必须验证真的落在里面，
            // 否则会预览一个用户根本没指的文件。
            if (point !== undefined) {
              const box = node.getBoundingClientRect()
              const inside =
                point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
              if (!inside) return null
            }
            return { button: buttons[0], card: node }
          }
        }
        node = node.parentElement
        depth += 1
      }
      return null
    }

    let focusTimer = null

    /** 和 Host 半共用的设置。启动时拉一次，设置页改完立即回写。 */
    let settings = { hoverDelay: 500, focusComposer: true, clickToPreview: false }

    function readSettings() {
      return fetch('api/quicklook.settings', { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : settings))
        .then((value) => {
          if (value !== null && typeof value === 'object') settings = value
          return settings
        })
        .catch(() => settings)
    }

    function writeSettings(patch) {
      // 本地先落，界面立刻响应；写盘失败也只是下次启动回到旧值。
      settings = { ...settings, ...patch }
      return fetch('api/quicklook.settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then((response) => (response.ok ? response.json() : settings))
        .then((value) => {
          if (value !== null && typeof value === 'object') settings = value
          publishSettings()
          return settings
        })
        .catch((error) => {
          warn('settings', error)
          return settings
        })
    }

    const settingsWatchers = new Set()

    function publishSettings() {
      for (const watcher of settingsWatchers) watcher(settings)
    }
    /** 这次窗口重新获得焦点，是因为刚关掉预览面板（而不是用户切回来）。 */
    let resumeComposer = false

    /**
     * 把焦点送进聊天输入框：面板关掉以后焦点回到 DSH，但落在哪儿不确定，
     * 用户下一步就是想接着打字。取页面里最靠下的可编辑元素——那才是输入框，
     * 顶部/侧栏那些是搜索框。
     */
    function focusComposer() {
      const nodes = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')
      let best = null
      let bestBottom = -Infinity
      for (const node of nodes) {
        if (node.isConnected !== true) continue
        if (node.disabled === true || node.readOnly === true) continue
        const box = node.getBoundingClientRect()
        if (box.width <= 0 || box.height <= 0) continue
        if (box.bottom > bestBottom) {
          bestBottom = box.bottom
          best = node
        }
      }
      if (best === null) return false
      try {
        best.focus({ preventScroll: true })
        return true
      } catch (error) {
        warn('focus composer', error)
        return false
      }
    }

    /**
     * 悬停半秒后把键盘焦点要回来。
     * 预览面板是另一个进程的窗口，关掉之后焦点可能停在别处；没有焦点时按空格
     * 会被系统或别的窗口先吃掉，用户就得先点一下页面。这里在鼠标停稳后主动
     * 把窗口和卡片拿回焦点，用户接着按空格即可。
     */
    function focusSoon(found) {
      if (focusTimer !== null) clearTimeout(focusTimer)
      focusTimer = setTimeout(() => {
        focusTimer = null
        if (hovered === null) return
        if (document.hasFocus() === false) {
          try {
            window.focus()
          } catch (error) {
            warn('focus window', error)
          }
        }
        const target = found.button
        if (typeof target?.focus === 'function' && document.activeElement !== target) {
          try {
            target.focus({ preventScroll: true })
          } catch (error) {
            warn('focus card', error)
          }
        }
        // window.focus() 不一定能把整个 app 激活（系统级限制），再让 helper 用
        // NSRunningApplication 兜一次；仍然没焦点就说明是别的窗口真在前台。
        if (document.hasFocus() === false) {
          window.setTimeout(() => {
            if (hovered === null || document.hasFocus()) return
            void post({ action: 'focus' }).catch(warn)
          }, 120)
        }
      }, Math.max(0, Number(settings.hoverDelay) || 0))
    }

    /** 记下卡片（而不是按钮）的矩形：面板从整张卡片的位置长出来。 */
    function remember(found) {
      if (found === null) {
        if (focusTimer !== null) {
          clearTimeout(focusTimer)
          focusTimer = null
        }
        if (hovered !== null) publish(null)
        return
      }
      const url = found.button.getAttribute('data-quicklook-url')
      if (url === null || url === '') {
        if (hovered !== null) publish(null)
        return
      }
      const element = found.card !== null ? found.card : found.button
      if (typeof element.getBoundingClientRect !== 'function') return
      publish({ url, element })
      focusSoon(found)
    }

    /** 元素此刻在视口里的矩形（CSS px）。页面滚动过之后必须现取。 */
    function boxOf(element) {
      if (element === null || typeof element?.getBoundingClientRect !== 'function') return null
      // 卡片可能已经被对话更新移出 DOM：那就不再提供一个假矩形。
      if (element.isConnected === false) return null
      const box = element.getBoundingClientRect()
      return { x: box.left, y: box.top, width: box.width, height: box.height }
    }

    /** DSH 窗口在屏幕上的矩形（CSS px，左上原点），给 helper 定位用。 */
    function windowBounds() {
      // 一律用视口基准：anchor 来自 getBoundingClientRect（视口坐标），
      // 宽高就必须取 innerWidth/innerHeight，窗口外框多出来的顶栏高度补进 y。
      // 用 outerHeight 会让面板起点整体偏一个标题栏的高度（无边框窗口下恰好不暴露）。
      const width = window.innerWidth
      const height = window.innerHeight
      const chrome = Math.max((window.outerHeight || height) - height, 0)
      return { x: window.screenX || 0, y: (window.screenY || 0) + chrome, width, height }
    }

    function post(payload) {
      return fetch('api/quicklook.preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
    }

    /** 收起当前面板。重复调用无害。 */
    function hide() {
      return post({ action: 'hide' }).catch(warn)
    }

    /**
     * 一次触发交给 helper 判定：没开就开、开着同一个文件就收起、开着别的文件就换过去。
     * 这样「开着/关着」这件事只有 helper 一个来源，不会和界面状态打架。
     */
    function trigger(entry) {
      // 面板一开宿主就失活；等它关掉、宿主重新拿到焦点时，把光标送回输入框。
      resumeComposer = true
      const target = coordinates(entry.url)
      if (target === null) return Promise.resolve()
      return post({
        ...target,
        action: 'toggle',
        bounds: windowBounds(),
        anchor: boxOf(entry.element),
      }).catch(warn)
    }

    /** 焦点在可编辑控件里时，空格属于用户正在打的字。 */
    function typingSomewhere(target) {
      if (target === null || typeof target !== 'object') return false
      if (target.isContentEditable === true) return true
      const tag = String(target.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      return typeof target.closest === 'function' && target.closest('[contenteditable="true"]') !== null
    }

    /**
     * 设置页里的一行：宿主只负责把行堆进「常规」，行里的标签、当前值、写回
     * 全归插件自己，所以这一块是自绘的。
     */
    function QuickLookSettings() {
      const [state, setState] = React.useState(settings)

      React.useEffect(() => {
        settingsWatchers.add(setState)
        void readSettings().then(setState)
        return () => {
          settingsWatchers.delete(setState)
        }
      }, [])

      const line = (label, hint, control) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '16px', padding: '7px 0' } },
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontSize: '13px' } }, label),
            hint !== null
              ? h('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '2px' } }, hint)
              : null,
          ),
          control,
        )

      const toggle = (key) =>
        h('input', {
          type: 'checkbox',
          checked: state[key] === true,
          style: { width: '16px', height: '16px', margin: 0, cursor: 'pointer' },
          onChange: (event) => {
            void writeSettings({ [key]: event.target.checked })
          },
        })

      const delay = Number(state.hoverDelay)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        h('div', { style: { fontSize: '13px', fontWeight: 600, padding: '4px 0 2px' } }, '快速预览'),
        line(
          '悬停接管焦点',
          '鼠标在交付卡片上停多久，把键盘焦点移过去（毫秒，0 表示立即）。',
          h('input', {
            type: 'number',
            min: 0,
            max: 3000,
            step: 100,
            value: Number.isFinite(delay) ? delay : 500,
            style: {
              width: '84px',
              padding: '3px 6px',
              fontSize: '13px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.28))',
              background: 'transparent',
              color: 'inherit',
            },
            onChange: (event) => {
              void writeSettings({ hoverDelay: Number(event.target.value) })
            },
          }),
        ),
        line('关闭后聚焦输入框', '预览关掉后把光标送回聊天输入框。', toggle('focusComposer')),
        line('双击卡片直接预览', '开启后双击整张卡片即可，不必按空格。', toggle('clickToPreview')),
      )
    }

    function QuickLookAction(props) {
      const target = coordinates(props.actionUrl)
      const unavailable = target === null || props.available === false
      const [active, setActive] = React.useState(false)
      const ref = React.useRef(null)

      // 鼠标停在卡片任意位置（不只是按钮）时也点亮，提示这里可以按空格。
      React.useEffect(() => {
        const watcher = (entry) => {
          const same = entry !== null && entry.url === props.actionUrl
          setActive((previous) => (previous === same ? previous : same))
        }
        watchers.add(watcher)
        return () => {
          watchers.delete(watcher)
        }
      }, [props.actionUrl])

      const enter = () => {
        const found = locate(ref.current)
        remember(found !== null ? found : { button: ref.current, card: ref.current })
      }

      return h(
        'button',
        {
          ref,
          type: 'button',
          disabled: unavailable,
          'data-quicklook-url': props.actionUrl,
          title: unavailable ? '快速预览不可用' : '快速预览（空格）',
          'aria-label': '快速预览',
          onMouseEnter: enter,
          onFocus: enter,
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            if (unavailable) return
            const found = locate(ref.current)
            if (found !== null) remember(found)
            const element = found !== null ? found.card : ref.current
            trigger({ url: props.actionUrl, element })
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            padding: 0,
            // 和宿主那组「预览 / 下拉」按钮之间留出呼吸位，否则三个方块会粘成一排
            margin: '0 0 0 8px',
            border: 'none',
            borderRadius: 6,
            // 悬停时只让图标变实、底色调到很淡的灰；不要用 fill-secondary，
            // 那个色在浅色主题下像一块实心方块，和旁边两个按钮挤在一起很重。
            background: active ? 'rgba(127, 127, 127, 0.10)' : 'transparent',
            color: 'inherit',
            cursor: unavailable ? 'default' : 'pointer',
            opacity: unavailable ? 0.3 : active ? 0.95 : 0.42,
            transition: 'background 120ms ease, opacity 120ms ease',
          },
        },
        // 空格键图标：用扁矩形描边画，别用 ␣ 字符——U+2423 在多数 UI 字体里
        // 会渲染成接近正方形的空框，看起来像"复选框"而不是空格键。
        h('span', {
          'aria-hidden': 'true',
          style: {
            display: 'block',
            width: 13,
            height: 6,
            border: '1.5px solid currentColor',
            borderRadius: 2,
            opacity: 0.9,
          },
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        void readSettings()

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            { name: 'settings.general.item', id: 'quicklook', order: 18 },
            QuickLookSettings,
          ),
        )

        ctx.slots.inject('deliverables.file.actions', () =>
          ctx.slots.register(
            { name: 'deliverables.file.actions', id: 'quicklook', order: 5 },
            QuickLookAction,
          ),
        )

        ctx.effect(() => {
          // 鼠标在整张卡片上就算"指着这个文件"：卡片的 rect 也从这里取。
          const onOver = (event) => {
            const found = locate(event.target, { x: event.clientX, y: event.clientY })
            if (found === null) return
            // 同一张卡片内部的 mouseover 会连续触发，没必要每次都重算并通知组件。
            const url = found.button.getAttribute('data-quicklook-url')
            if (url !== null && hovered !== null && hovered.url === url) return
            remember(found)
          }
          // 双击整张卡片直接预览：默认关，设置里打开才生效。
          const onDoubleClick = (event) => {
            if (settings.clickToPreview !== true) return
            const found = locate(event.target, { x: event.clientX, y: event.clientY })
            if (found === null) return
            const url = found.button.getAttribute('data-quicklook-url')
            if (url === null || url === '') return
            event.preventDefault()
            event.stopPropagation()
            remember(found)
            if (hovered !== null) void trigger(hovered)
          }

          const onOut = (event) => {
            const to = event.relatedTarget
            if (to !== null && typeof to === 'object' && locate(to) !== null) return
            // relatedTarget 为 null 也可能只是卡片被 React 重建了（流式输出），鼠标其实没动。
            // 下一帧用坐标再确认一次，避免"鼠标明明在卡片上、按空格却没反应"。
            if (to === null) {
              const point = { x: event.clientX, y: event.clientY }
              requestAnimationFrame(() => {
                const under = document.elementFromPoint(point.x, point.y)
                if (under !== null && locate(under, point) !== null) return
                if (hovered !== null) publish(null)
              })
              return
            }
            if (hovered !== null) publish(null)
          }

          const onKeyDown = (event) => {
            // Esc：只在鼠标停在卡片上时兜底收起。
            // 刻意不 preventDefault/stopPropagation——Esc 是宿主自己在用的键
            // （关弹窗、取消生成），在捕获阶段抢走它会把这些功能弄哑。
            if (event.key === 'Escape') {
              if (hovered !== null) hide()
              return
            }
            if (event.key !== ' ' && event.code !== 'Space') return
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
            if (event.repeat) return
            if (typingSomewhere(event.target)) return
            if (hovered === null) return
            event.preventDefault()
            event.stopImmediatePropagation()
            trigger(hovered)
          }

          document.addEventListener('mouseover', onOver, true)
          document.addEventListener('mouseout', onOut, true)
          // 预览面板是独立窗口，关掉之后 DSH 重新获得焦点——这时把光标送回输入框。
          const onWindowFocus = () => {
            if (!resumeComposer) return
            resumeComposer = false
            if (settings.focusComposer !== false) focusComposer()
          }
          window.addEventListener('focus', onWindowFocus)
          document.addEventListener('dblclick', onDoubleClick, true)
          document.addEventListener('keydown', onKeyDown, true)
          return () => {
            document.removeEventListener('mouseover', onOver, true)
            document.removeEventListener('mouseout', onOut, true)
            document.removeEventListener('dblclick', onDoubleClick, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('focus', onWindowFocus)
            hide()
            publish(null)
          }
        })
      },
    }
  },
})
