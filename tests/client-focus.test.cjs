const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the real registered client and React handlers, with no browser packages.
function setup({ focused = true } = {}) {
  let now = 0, nextId = 0, windowFocuses = 0
  const timers = new Map(), posts = [], disposers = [], components = new Map()
  const schedule = (fn, delay = 0) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id }
  const clear = (id) => timers.delete(id)
  const tick = (ms) => {
    const end = now + ms
    for (;;) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!first || first[1].at > end) break
      now = first[1].at; timers.delete(first[0]); first[1].fn()
    }
    now = end
  }
  const eventTarget = () => {
    const listeners = new Map()
    return {
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
      dispatch(type, fields = {}) {
        const event = { type, target: document.body, relatedTarget: null, clientX: 5, clientY: 5,
          preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...fields }
        for (const fn of [...(listeners.get(type) || [])]) fn(event)
      },
      count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0) },
    }
  }
  const document = { ...eventTarget(), hasFocus: () => focused, elementFromPoint: () => null }
  class Element {
    constructor(tag = 'div', attrs = {}, parent = null) {
      this.tagName = tag.toUpperCase(); this.attrs = attrs; this.parentElement = parent
      this.children = []; this.isConnected = true; this.disabled = false; this.focuses = 0
      if (parent) parent.children.push(this)
    }
    getAttribute(name) { return this.attrs[name] ?? null }
    contains(node) { return node === this || this.children.some(child => child.contains(node)) }
    matches(selector) {
      if (selector === '[data-presented-file]') return this.attrs['data-presented-file'] !== undefined
      if (selector === '[data-quicklook-url]') return this.attrs['data-quicklook-url'] !== undefined
      if (selector === '[contenteditable="true"]') return this.attrs.contenteditable === 'true'
      return false
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null }
    querySelectorAll(selector) { return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } }
    focus() {
      this.focuses++
      const previous = document.activeElement
      if (previous === this) return
      document.dispatch('focusout', { target: previous, relatedTarget: this })
      document.activeElement = this
      document.dispatch('focusin', { target: this, relatedTarget: previous })
      this.onFocus?.()
    }
  }
  document.body = new Element('body'); document.activeElement = document.body
  const window = { ...eventTarget(), location: { href: 'http://localhost/' }, focus() { windowFocuses++ },
    setTimeout: schedule, innerWidth: 800, innerHeight: 600, outerHeight: 640 }
  const React = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, () => {}], useRef: value => ({ current: value }),
    useEffect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose) } }
  window.__ModuleLoader__ = { load({ factory }) {
    factory(() => React).apply({ slots: {
      inject(_name, fn) { fn() }, register({ name }, component) { components.set(name, component) },
    }, effect(fn) { disposers.push(fn()) } })
  } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client.js'), 'utf8'), {
    window, document, URL, console, setTimeout: schedule, clearTimeout: clear,
    requestAnimationFrame: fn => schedule(fn, 16), cancelAnimationFrame: clear,
    fetch(url, options) {
      if (url === 'api/quicklook.settings') return new Promise(() => {})
      posts.push(JSON.parse(options.body)); return Promise.resolve({ ok: true, json: async () => ({}) })
    },
  }, { filename: 'client.js' })
  const card = (index = 0) => {
    const root = new Element('div', { 'data-presented-file': '' }, document.body)
    const url = `http://localhost/file?sessionId=test&seq=1&index=${index}`
    const rendered = components.get('deliverables.file.actions')({ actionUrl: url })
    const button = new Element('button', { 'data-quicklook-url': url }, root)
    rendered.props.ref.current = button; button.onFocus = rendered.props.onFocus
    return { root, button, props: rendered.props }
  }
  const hover = item => document.dispatch('mouseover', { target: item.root })
  const leave = (target = document.body) => document.dispatch('mouseout', { relatedTarget: target })
  const unmount = () => { for (const fn of disposers.reverse()) fn() }
  return { document, window, Element, timers, posts, tick, card, hover, leave, unmount,
    windowFocuses: () => windowFocuses, focusPosts: () => posts.filter(post => post.action === 'focus') }
}

test('normal hover focuses once and synchronous React onFocus does not reschedule', () => {
  const env = setup(), card = env.card()
  env.hover(card); env.tick(499); assert.equal(card.button.focuses, 0)
  env.tick(1); assert.equal(env.document.activeElement, card.button)
  env.tick(1000); assert.equal(card.button.focuses, 1); assert.equal(env.timers.size, 0)
})

test('unfocused window retains the cancellable 120ms system fallback after internal focus', () => {
  const env = setup({ focused: false }), card = env.card()
  env.hover(card); env.tick(500)
  assert.equal(card.button.focuses, 1); assert.equal(env.windowFocuses(), 1)
  env.tick(119); assert.equal(env.focusPosts().length, 0)
  env.tick(1); assert.equal(env.focusPosts().length, 1)
})

for (const tag of ['input', 'textarea', 'select', 'contenteditable-child']) {
  test(`hover moves ${tag} focus onto the card so space previews`, () => {
    const env = setup({ focused: false }), card = env.card()
    let input = new env.Element(tag, {}, env.document.body)
    if (tag === 'contenteditable-child') {
      const editor = new env.Element('div', { contenteditable: 'true' }, env.document.body)
      input = new env.Element('span', {}, editor)
    }
    input.focus(); env.hover(card); env.tick(499)
    assert.equal(env.document.activeElement, input); assert.equal(card.button.focuses, 0)
    env.tick(1)
    assert.equal(env.document.activeElement, card.button)
    assert.equal(card.button.focuses, 1); assert.equal(env.windowFocuses(), 1)
  })
}

for (const event of ['Tab', 'letter', 'focus-change', 'focus-return', 'beforeinput', 'input']) {
  test(`${event} during hover delay permanently cancels pending activation`, () => {
    const env = setup({ focused: false }), card = env.card()
    env.hover(card); env.tick(250)
    if (event.startsWith('focus')) {
      new env.Element('button', {}, env.document.body).focus()
      if (event === 'focus-return') env.document.body.focus()
    } else if (event === 'Tab' || event === 'letter') {
      env.document.dispatch('keydown', { key: event === 'Tab' ? 'Tab' : 'a' })
    } else env.document.dispatch(event)
    env.tick(1000)
    assert.equal(card.button.focuses, 0); assert.equal(env.windowFocuses(), 0)
    assert.equal(env.focusPosts().length, 0)
  })
}

for (const change of ['detach-button', 'detach-card', 'disable', 'url', 'move-button']) {
  test(`invalid DOM (${change}) prevents hover activation`, () => {
    const env = setup(), card = env.card(); env.hover(card)
    if (change === 'detach-button') card.button.isConnected = false
    if (change === 'detach-card') card.root.isConnected = false
    if (change === 'disable') card.button.disabled = true
    if (change === 'url') card.button.attrs['data-quicklook-url'] = 'changed'
    if (change === 'move-button') card.root.children = []
    env.tick(1000); assert.equal(card.button.focuses, 0)
  })
}

for (const change of ['Tab', 'input-focus', 'input', 'leave', 'null-leave', 'new-hover', 'unmount']) {
  test(`${change} cancels the old 120ms fallback`, () => {
    const env = setup({ focused: false }), card = env.card(); env.hover(card); env.tick(500)
    if (change === 'Tab') env.document.dispatch('keydown', { key: 'Tab' })
    if (change === 'input-focus') new env.Element('input', {}, env.document.body).focus()
    if (change === 'input') env.document.dispatch('input')
    if (change === 'leave') env.leave()
    if (change === 'null-leave') env.leave(null)
    if (change === 'new-hover') env.hover(env.card(1))
    if (change === 'unmount') env.unmount()
    env.tick(120); assert.equal(env.focusPosts().length, 0)
    if (change === 'unmount') {
      assert.equal(env.timers.size, 0); assert.equal(env.document.count(), 0); assert.equal(env.window.count(), 0)
    }
  })
}

test('leave and unmount clear the primary delay and pending animation frame', () => {
  for (const mode of ['leave', 'unmount', 'null-leave-unmount']) {
    const env = setup({ focused: false }), card = env.card(); env.hover(card)
    if (mode.includes('null-leave')) env.leave(null)
    if (mode.includes('unmount')) env.unmount(); else env.leave()
    env.tick(1000); assert.equal(card.button.focuses, 0); assert.equal(env.focusPosts().length, 0)
    assert.equal(env.timers.size, 0)
  }
})

test('keyboard cancellation preserves hover space-to-preview behavior', () => {
  const env = setup(), card = env.card()
  env.hover(card)
  let prevented = false
  env.document.dispatch('keydown', { key: ' ', code: 'Space', preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(env.posts.filter(post => post.action === 'toggle').length, 1)
  env.tick(1000); assert.equal(card.button.focuses, 0)
})

test('focus changes synchronously during window activation stop button activation', () => {
  const env = setup({ focused: false }), card = env.card()
  const input = new env.Element('input', {}, env.document.body)
  env.window.focus = () => input.focus()
  env.hover(card); env.tick(1000)
  assert.equal(env.document.activeElement, input)
  assert.equal(card.button.focuses, 0); assert.equal(env.focusPosts().length, 0)
})

test('same-card mouseover does not postpone the original activation', () => {
  const env = setup(), card = env.card()
  env.hover(card); env.tick(300)
  env.document.dispatch('mouseover', { target: card.button }); env.tick(200)
  assert.equal(card.button.focuses, 1)
})

test('same URL on a different card replaces the pending hover target', () => {
  const env = setup(), first = env.card(), second = env.card()
  env.hover(first); env.tick(300); env.hover(second); env.tick(200)
  assert.equal(first.button.focuses, 0); assert.equal(second.button.focuses, 0)
  env.tick(300); assert.equal(second.button.focuses, 1)
})

test('typing in a focused input during the hover delay keeps focus where it is', () => {
  const env = setup({ focused: false }), card = env.card()
  const input = new env.Element('textarea', {}, env.document.body)
  input.focus(); env.hover(card); env.tick(250)
  env.document.dispatch('keydown', { target: input, key: 'a' })
  env.tick(1000)
  assert.equal(env.document.activeElement, input)
  assert.equal(card.button.focuses, 0)
  assert.deepEqual(env.posts, [])
})
