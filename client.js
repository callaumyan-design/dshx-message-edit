// dshx-message-edit — browser half (v1.2.0).
//
// UI (verified against dsh-client-ui-chat / -renderer / -slots 0.2.0-rc.2):
//
// * A pen button sits IN the native action row (next to copy / branch) of both
//   your prompts and the AI replies, using the native button's own class, so it
//   looks and hovers exactly like its neighbours.
// * Edits replace what is shown in place:
//     - prompt: the old prompt and its replies are hidden; the corrected prompt
//       and the regenerated answer take their place;
//     - reply: the reply body renders the edited text.
// * A ChatGPT-style switcher "‹ 2/3 ›" appears next to the pen once a message
//   has more than one version, switching between the original and the edits.
//
// HOW
//
// * Display replacement shadows the Chat's own keyed renderers
//   (`conversation.chat.node` keys `user` and `assistant-step`) at a lower
//   priority — the slot registry's shadowing rule ("lowest renders"). The
//   wrapper renders the ORIGINAL component (read live from ctx.slots.entries)
//   with adjusted props, so the native look is kept. If the wrapper throws, the
//   renderer's error boundary retires it and the original renderer takes over.
// * Each prompt version opens one turn, so a version's branch is
//   [its turn, next version's turn - 1] (the newest is open-ended). Hidden turns
//   get display:none via one generated stylesheet keyed on
//   `[data-conversation-session] [data-chat-turn]`.
window.__ModuleLoader__.load({
  id: 'dshx-message-edit',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const reactDom = require('react-dom')
    const reactDomClient = require('react-dom/client')
    const primitives = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return {} } })()

    const exports = {}
    const NS = 'dshx-message-edit'
    const BASE = '/dshx-message-edit'
    const USER_KEY_PREFIX = '13:input-message'
    const NODE_SLOT = 'conversation.chat.node'
    const STALE_MS = 1500

    let translate = (key) => key
    const tr = (key) => translate(key)

    // -----------------------------------------------------------------------
    // transport
    // -----------------------------------------------------------------------

    async function callHost(path, init) {
      const response = await fetch(BASE + path, { credentials: 'same-origin', ...init })
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (!response.ok) throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status)
      return payload
    }
    const query = (params) => '?' + new URLSearchParams(params).toString()
    const postJson = (path, body) => callHost(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    // -----------------------------------------------------------------------
    // stores
    // -----------------------------------------------------------------------

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => { value = next; for (const listener of [...listeners]) listener() },
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      }
    }
    const useStore = (store) => React.useSyncExternalStore(store.subscribe, store.get)

    const EMPTY_STATE = { live: false, liveUserIds: null, overrides: {}, groups: [] }
    /** sessionId -> { live, liveUserIds:Set|null, overrides:{id:[text]}, groups:[[{id,turn}]], fetchedAt, pending } */
    const sessionState = createStore(new Map())
    /** 'p:<headId>' | 'a:<messageId>' -> selected version index */
    const selection = createStore(new Map())
    /** sessionId -> { fromId, from, to } while a prompt edit awaits its successor */
    const pendingHide = createStore(new Map())

    const stateOf = (sessionId) => sessionState.get().get(sessionId)
    const updateMap = (store, key, value) => {
      const next = new Map(store.get())
      if (value === undefined) next.delete(key)
      else next.set(key, value)
      store.set(next)
    }

    async function refresh(sessionId, force) {
      const current = stateOf(sessionId)
      if (current?.pending) return
      if (!force && current !== undefined && Date.now() - current.fetchedAt < STALE_MS) return
      const startedAt = Date.now()
      updateMap(sessionState, sessionId, { ...(current ?? EMPTY_STATE), fetchedAt: current?.fetchedAt ?? 0, pending: true })
      let next
      try {
        const payload = await callHost('/state' + query({ sessionId }))
        next = {
          live: payload.live === true,
          liveUserIds: Array.isArray(payload.liveUserIds) ? new Set(payload.liveUserIds) : null,
          overrides: payload.overrides ?? {},
          groups: Array.isArray(payload.promptVersions) ? payload.promptVersions : [],
          fetchedAt: startedAt,
          pending: false,
        }
      } catch {
        next = { ...(current ?? EMPTY_STATE), fetchedAt: startedAt, pending: false }
      }
      updateMap(sessionState, sessionId, next)
      const waiting = pendingHide.get().get(sessionId)
      if (waiting !== undefined && next.groups.some((group) => {
        const index = group.findIndex((version) => version.id === waiting.fromId)
        return index >= 0 && index < group.length - 1
      })) updateMap(pendingHide, sessionId, undefined)
    }

    /** Poll until a just-edited prompt's successor is logged (bounded). */
    async function awaitSuccessor(sessionId) {
      for (let attempt = 0; attempt < 60 && pendingHide.get().has(sessionId); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await refresh(sessionId, true)
      }
      updateMap(pendingHide, sessionId, undefined)
    }

    const groupOf = (state, messageId) => state?.groups?.find((group) => group.some((version) => version.id === messageId))

    // -----------------------------------------------------------------------
    // text helpers
    // -----------------------------------------------------------------------

    const flatten = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

    /** Replace a Chat assistant node's text blocks with one text block. */
    function withText(blocks, text) {
      const out = []
      let placed = false
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block?.kind === 'text') {
          if (!placed) { out.push({ kind: 'text', text }); placed = true }
          continue
        }
        out.push(block)
      }
      if (!placed) out.push({ kind: 'text', text })
      return out
    }

    // -----------------------------------------------------------------------
    // dialog
    // -----------------------------------------------------------------------

    const dialog = createStore(null)
    const patchDialog = (patch) => { if (dialog.get() !== null) dialog.set({ ...dialog.get(), ...patch }) }

    async function openEditor(kind, sessionId, messageId, seedText) {
      const token = {}
      const seeded = typeof seedText === 'string'
      dialog.set({ kind, sessionId, messageId, original: seedText ?? '', text: seedText ?? '', loading: !seeded, busy: false, error: null, token })
      if (seeded) return
      try {
        const payload = await callHost('/message' + query({ sessionId, messageId }))
        if (dialog.get()?.token !== token) return
        patchDialog({ original: payload.text ?? '', text: payload.text ?? '', loading: false })
      } catch (error) {
        if (dialog.get()?.token === token) patchDialog({ loading: false, error: String(error?.message ?? error) })
      }
    }

    async function saveEditor() {
      const state = dialog.get()
      if (state === null || state.busy || state.loading) return
      patchDialog({ busy: true, error: null })
      try {
        const result = await postJson(state.kind === 'prompt' ? '/edit-prompt' : '/edit-assistant', {
          sessionId: state.sessionId, messageId: state.messageId, text: state.text,
        })
        dialog.set(null)
        if (state.kind === 'prompt') {
          const turns = result?.withdrawnTurns
          if (Number.isSafeInteger(turns?.from) && Number.isSafeInteger(turns?.to)) {
            updateMap(pendingHide, state.sessionId, { fromId: state.messageId, from: turns.from, to: turns.to })
          }
          // Jump every prompt group back to its newest version.
          const next = new Map(selection.get())
          for (const key of [...next.keys()]) if (key.startsWith('p:')) next.delete(key)
          selection.set(next)
          void awaitSuccessor(state.sessionId)
        } else {
          updateMap(selection, 'a:' + state.messageId, undefined)
        }
        await refresh(state.sessionId, true)
      } catch (error) {
        patchDialog({ busy: false, error: tr('error.failed') + String(error?.message ?? error) })
      }
    }

    /** Grow a textarea to fit its content, between ~3 lines and 60% of the viewport. */
    function fitHeight(node) {
      if (!node) return
      const max = Math.max(160, Math.round(window.innerHeight * 0.6))
      node.style.height = 'auto'
      const next = Math.min(node.scrollHeight + 2, max)
      node.style.height = next + 'px'
      node.style.overflowY = node.scrollHeight + 2 > max ? 'auto' : 'hidden'
    }

    const CLOSE_PATH = 'M4 4l8 8M12 4l-8 8'

    function EditDialog() {
      const state = useStore(dialog)
      const areaRef = React.useRef(null)
      const open = state !== null
      React.useEffect(() => {
        if (!open || state.loading) return
        const node = areaRef.current
        if (node) { node.focus(); node.setSelectionRange(node.value.length, node.value.length) }
      }, [open, state?.loading, state?.messageId])
      React.useLayoutEffect(() => { if (open) fitHeight(areaRef.current) }, [open, state?.text, state?.loading])
      React.useEffect(() => {
        if (!open) return undefined
        const onResize = () => fitHeight(areaRef.current)
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [open])
      if (!open) return null

      const isPrompt = state.kind === 'prompt'
      const dirty = flatten(state.text) !== flatten(state.original)
      const canSave = !state.busy && !state.loading && state.text.trim().length > 0 && dirty
      const close = () => { if (!state.busy) dialog.set(null) }
      const save = () => { if (canSave) void saveEditor() }
      const length = state.loading ? 0 : [...state.text].length

      return reactDom.createPortal(
        h('div', {
          className: 'dshx-dlg-backdrop',
          onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
        },
        h('div', { role: 'dialog', 'aria-modal': true, className: 'dshx-dlg' + (isPrompt ? ' is-prompt' : ' is-reply') },
          h('div', { className: 'dshx-dlg-head' },
            h('span', { className: 'dshx-dlg-icon' }, h(PenIcon)),
            h('div', { className: 'dshx-dlg-title' }, isPrompt ? tr('dialog.promptTitle') : tr('dialog.replyTitle')),
            h('button', { type: 'button', className: 'dshx-dlg-x', 'aria-label': tr('dialog.cancel'), onClick: close, disabled: state.busy },
              h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                h('path', { d: CLOSE_PATH, stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })))),
          h('div', { className: 'dshx-dlg-hint' }, isPrompt ? tr('dialog.promptWarning') : tr('dialog.replyWarning')),
          h('div', { className: 'dshx-dlg-field' + (state.loading ? ' is-loading' : '') },
            h('textarea', {
              ref: areaRef,
              rows: 2,
              value: state.loading ? tr('dialog.loading') : state.text,
              disabled: state.loading || state.busy,
              onChange: (event) => patchDialog({ text: event.target.value }),
              spellCheck: false,
              onKeyDown: (event) => {
                if (event.key === 'Escape') { event.preventDefault(); close() }
                else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save() }
              },
            })),
          state.error && h('div', { className: 'dshx-dlg-error' }, state.error),
          h('div', { className: 'dshx-dlg-foot' },
            h('div', { className: 'dshx-dlg-meta' },
              !state.loading && h('span', { className: dirty ? 'is-dirty' : '' }, dirty ? tr('dialog.dirty') : tr('dialog.clean')),
              !state.loading && h('span', null, length + ' ' + tr('dialog.chars')),
              h('kbd', null, 'Ctrl'), h('kbd', null, 'Enter')),
            h('button', { type: 'button', className: 'dshx-dlg-btn', onClick: close, disabled: state.busy }, tr('dialog.cancel')),
            h('button', { type: 'button', className: 'dshx-dlg-btn is-primary', onClick: save, disabled: !canSave },
              state.busy ? tr('dialog.saving') : (isPrompt ? tr('dialog.confirmPrompt') : tr('dialog.confirmReply')))))),
        document.body,
      )
    }

    // -----------------------------------------------------------------------
    // native-looking action buttons
    // -----------------------------------------------------------------------

    const fallbackIcon = (d) => () => h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d, stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round' }))
    const PenIcon = primitives.IconEditOutlineRegular ?? fallbackIcon('M11.1 2.6a1.4 1.4 0 0 1 2 2L6 11.7l-2.6.7.7-2.6 7-7.2Z')
    const LeftIcon = primitives.IconChevronLeftOutlineRegular ?? fallbackIcon('M10 3.5 5.5 8l4.5 4.5')
    const RightIcon = primitives.IconChevronRightOutlineRegular ?? fallbackIcon('M6 3.5 10.5 8 6 12.5')

    const withTooltip = (label, button) => (primitives.Tooltip ? h(primitives.Tooltip, { label, side: 'bottom' }, button) : button)

    /** Copy the class of the native button in the same action row. */
    function useNativeButtonClass(anchorRef) {
      const [className, setClassName] = React.useState('')
      React.useLayoutEffect(() => {
        const row = anchorRef.current?.parentElement?.closest?.('[data-clock]') ?? anchorRef.current?.closest?.('[data-clock]')
        const native = row?.querySelector?.('button:not([data-dshx-btn])')
        const value = typeof native?.className === 'string' ? native.className : ''
        if (value !== className) setClassName(value)
      })
      return className
    }

    const stop = (event) => { event.preventDefault(); event.stopPropagation() }

    function ActionGroup({ editLabel, onEdit, versions, index, onSelect }) {
      const anchorRef = React.useRef(null)
      const nativeClass = useNativeButtonClass(anchorRef)
      const cls = 'dshx-act' + (nativeClass ? ' ' + nativeClass : '')
      return h('span', { ref: anchorRef, 'data-dshx-actions': '', style: { display: 'contents' } },
        onEdit && withTooltip(editLabel, h('button', {
          type: 'button', className: cls, 'data-dshx-btn': '', 'aria-label': editLabel,
          onClick: (event) => { stop(event); onEdit() },
        }, h(PenIcon))),
        versions > 1 && h('span', { className: 'dshx-switch' },
          h('button', {
            type: 'button', className: cls + ' dshx-arrow', 'data-dshx-btn': '', 'aria-label': tr('version.previous'),
            disabled: index <= 0, onClick: (event) => { stop(event); onSelect(index - 1) },
          }, h(LeftIcon)),
          h('span', { className: 'dshx-count' }, (index + 1) + '/' + versions),
          h('button', {
            type: 'button', className: cls + ' dshx-arrow', 'data-dshx-btn': '', 'aria-label': tr('version.next'),
            disabled: index >= versions - 1, onClick: (event) => { stop(event); onSelect(index + 1) },
          }, h(RightIcon))))
    }

    // -----------------------------------------------------------------------
    // shadowing wrappers for the Chat's own renderers
    // -----------------------------------------------------------------------

    let slotsService = null

    /** The renderer being shadowed: lowest-priority entry for `key` that is not ours. */
    function originalEntry(key, self) {
      let best
      for (const entry of slotsService?.entries?.(NODE_SLOT) ?? []) {
        if (entry.options?.key !== key || entry.component === self) continue
        if (best === undefined || (entry.options.priority ?? 0) < (best.options.priority ?? 0)) best = entry
      }
      return best
    }

    const stripOwn = (props) => {
      const { dshxSessionId: _sessionId, ...rest } = props
      return rest
    }

    // --- user prompt ---------------------------------------------------------

    function UserDecorated({ props, Original }) {
      const sessionId = props.dshxSessionId
      const key = props.node?.key
      const messageId = typeof key === 'string' && key.startsWith(USER_KEY_PREFIX) ? key.slice(USER_KEY_PREFIX.length) : null
      const states = useStore(sessionState)
      const selected = useStore(selection)
      const wrapRef = React.useRef(null)
      const [mount] = React.useState(() => {
        const span = document.createElement('span')
        span.style.display = 'contents'
        span.setAttribute('data-dshx-mount', '')
        return span
      })

      React.useEffect(() => { if (sessionId) void refresh(sessionId, false) }, [sessionId, messageId])
      React.useLayoutEffect(() => {
        const row = wrapRef.current?.querySelector?.('[data-clock="start"]')
        if (row && mount.parentElement !== row) row.appendChild(mount)
      })
      React.useEffect(() => () => mount.remove(), [mount])

      const content = h('div', { ref: wrapRef, style: { display: 'contents' } }, h(Original, stripOwn(props)))
      if (!sessionId || !messageId) return content

      const state = states.get(sessionId)
      const group = groupOf(state, messageId)
      const position = group ? group.findIndex((version) => version.id === messageId) : -1
      const editable = state?.liveUserIds instanceof Set
        ? state.liveUserIds.has(messageId)
        : group === undefined || position === group.length - 1
      const groupKey = group ? 'p:' + group[0].id : null

      return h(React.Fragment, null, content,
        reactDom.createPortal(h(ActionGroup, {
          editLabel: tr('action.editPrompt'),
          onEdit: editable ? () => void openEditor('prompt', sessionId, messageId) : null,
          versions: group?.length ?? 0,
          index: Math.max(0, position),
          onSelect: (next) => { if (groupKey) updateMap(selection, groupKey, Math.max(0, Math.min(group.length - 1, next))) },
        }), mount))
    }

    function UserNode(props) {
      const original = originalEntry('user', UserNode)
      return original === undefined ? null : h(UserDecorated, { props, Original: original.component })
    }

    // --- assistant reply -----------------------------------------------------

    function AssistantDecorated({ props, Original }) {
      const sessionId = props.dshxSessionId
      const messageId = props.node?.data?.finalNode?.messageId
      const states = useStore(sessionState)
      const selected = useStore(selection)
      React.useEffect(() => { if (sessionId && messageId) void refresh(sessionId, false) }, [sessionId, messageId])

      const rest = stripOwn(props)
      const edits = messageId ? states.get(sessionId)?.overrides?.[messageId] : undefined
      if (!Array.isArray(edits) || edits.length === 0) return h(Original, rest)
      const index = Math.min(selected.get('a:' + messageId) ?? edits.length, edits.length)
      if (index <= 0) return h(Original, rest)
      const node = rest.node
      return h(Original, { ...rest, node: { ...node, data: { ...node.data, blocks: withText(node.data.blocks, edits[index - 1]) } } })
    }

    function AssistantNode(props) {
      const original = originalEntry('assistant-step', AssistantNode)
      return original === undefined ? null : h(AssistantDecorated, { props, Original: original.component })
    }

    /** Pen + version switcher in the reply's native action row. */
    function ReplyActions({ messageId, sessionId }) {
      const states = useStore(sessionState)
      const selected = useStore(selection)
      React.useEffect(() => { if (sessionId) void refresh(sessionId, false) }, [sessionId, messageId])
      const edits = states.get(sessionId)?.overrides?.[messageId]
      const versions = Array.isArray(edits) ? edits.length + 1 : 1
      const index = Math.min(selected.get('a:' + messageId) ?? versions - 1, versions - 1)
      return h(ActionGroup, {
        editLabel: tr('action.editReply'),
        onEdit: () => void openEditor('assistant', sessionId, messageId),
        versions,
        index,
        onSelect: (next) => updateMap(selection, 'a:' + messageId, Math.max(0, Math.min(versions - 1, next))),
      })
    }

    // -----------------------------------------------------------------------
    // turn hiding for prompt versions
    // -----------------------------------------------------------------------

    function hiddenRanges(sessionId) {
      const state = stateOf(sessionId)
      const selected = selection.get()
      const ranges = []
      for (const group of state?.groups ?? []) {
        if (group.some((version) => !Number.isSafeInteger(version.turn))) continue
        const chosen = selected.get('p:' + group[0].id) ?? group.length - 1
        group.forEach((version, index) => {
          if (index !== chosen) ranges.push([version.turn, index < group.length - 1 ? group[index + 1].turn - 1 : Infinity])
        })
      }
      const waiting = pendingHide.get().get(sessionId)
      if (waiting !== undefined) ranges.push([waiting.from, waiting.to])
      return ranges
    }

    let styleEl = null
    let scheduled = false
    function scheduleDecorate() {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => { scheduled = false; decorate() })
    }

    function decorate() {
      if (styleEl === null) return
      const rules = []
      for (const root of document.querySelectorAll('[data-conversation-session]')) {
        const sessionId = root.getAttribute('data-conversation-session')
        if (!sessionId) continue
        const ranges = hiddenRanges(sessionId)
        if (ranges.length === 0) continue
        const turns = new Set()
        for (const row of root.querySelectorAll('[data-chat-turn]')) {
          const turn = Number(row.getAttribute('data-chat-turn'))
          if (Number.isSafeInteger(turn) && ranges.some(([from, to]) => turn >= from && turn <= to)) turns.add(turn)
        }
        const scope = '[data-conversation-session="' + CSS.escape(sessionId) + '"]'
        for (const turn of turns) rules.push(scope + ' [data-chat-turn="' + turn + '"]')
      }
      const css = rules.length === 0 ? '' : rules.join(',\n') + '{display:none!important}'
      if (styleEl.textContent !== css) styleEl.textContent = css
    }

    const STYLE_TEXT = `
.dshx-act{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.dshx-act svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
[data-clock=end] .dshx-act svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}
.dshx-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshx-switch{display:inline-flex;align-items:center}
.dshx-act.dshx-arrow{width:calc(22px + var(--dsh-content-font-delta,0px));padding:4px}
.dshx-act.dshx-arrow svg{width:calc(13px + var(--dsh-content-font-delta,0px));height:calc(13px + var(--dsh-content-font-delta,0px))}
.dshx-act.dshx-arrow:disabled{opacity:.35;cursor:default;background:0 0}
.dshx-count{font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:2.4em;text-align:center}
@keyframes dshx-fade{from{opacity:0}to{opacity:1}}
@keyframes dshx-pop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
.dshx-dlg-backdrop{position:fixed;inset:0;z-index:21000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.28);backdrop-filter:blur(2px);animation:dshx-fade .12s ease-out}
.dshx-dlg{box-sizing:border-box;width:min(640px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;gap:12px;padding:18px 18px 14px;border-radius:16px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#fff));backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.22));border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));animation:dshx-pop .16s cubic-bezier(.2,.8,.2,1)}
.dshx-dlg-head{display:flex;align-items:center;gap:10px}
.dshx-dlg-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 12%,transparent)}
.dshx-dlg-icon svg{width:15px;height:15px}
.dshx-dlg-title{flex:auto;font-size:15px;font-weight:600;line-height:22px}
.dshx-dlg-x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshx-dlg-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshx-dlg-x svg{width:14px;height:14px}
.dshx-dlg-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}
.dshx-dlg-field{border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.25));background:var(--dsw-alias-bg-base,transparent);transition:border-color .12s,box-shadow .12s}
.dshx-dlg-field:focus-within{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 16%,transparent)}
.dshx-dlg-field textarea{display:block;box-sizing:border-box;width:100%;min-height:46px;margin:0;padding:10px 12px;border:0;outline:0;resize:none;background:0 0;color:inherit;font:inherit;font-size:14px;line-height:22px;overflow-y:hidden;scrollbar-width:thin}
.dshx-dlg-field.is-loading textarea{color:var(--dsw-alias-label-tertiary)}
.dshx-dlg-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#c0392b);white-space:pre-wrap}
.dshx-dlg-foot{display:flex;align-items:center;gap:8px}
.dshx-dlg-meta{flex:auto;display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshx-dlg-meta .is-dirty{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dshx-dlg-meta kbd{font:inherit;font-size:10px;padding:1px 5px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,transparent)}
.dshx-dlg-meta kbd+kbd{margin-left:-4px}
.dshx-dlg-btn{height:32px;padding:0 16px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dshx-dlg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshx-dlg-btn.is-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-weight:500}
.dshx-dlg-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4d6bfe);filter:brightness(1.08)}
.dshx-dlg-btn:disabled{opacity:.45;cursor:default}`

    // -----------------------------------------------------------------------
    // apply
    // -----------------------------------------------------------------------

    exports.name = NS
    exports.inject = ['slots', 'locale']

    exports.apply = (ctx) => {
      slotsService = ctx.slots

      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          'action.editPrompt': '编辑',
          'action.editReply': '编辑回复',
          'version.previous': '上一个版本',
          'version.next': '下一个版本',
          'dialog.promptTitle': '编辑提示词',
          'dialog.replyTitle': '编辑 AI 回复',
          'dialog.promptWarning': '保存后将从这里重新生成回答，之后的对话会被替换；旧版本可用 ‹ › 切换查看。',
          'dialog.replyWarning': '保存后回复显示为新内容，模型也会读取它；后续对话保留，原文可用 ‹ › 切换查看。',
          'dialog.confirmPrompt': '保存并重新生成',
          'dialog.confirmReply': '保存',
          'dialog.cancel': '取消',
          'dialog.saving': '处理中…',
          'dialog.loading': '正在读取原文…',
          'dialog.dirty': '内容已修改',
          'dialog.clean': '内容未修改',
          'dialog.chars': '字',
          'error.failed': '修改失败：',
        },
        en: {
          'action.editPrompt': 'Edit',
          'action.editReply': 'Edit reply',
          'version.previous': 'Previous version',
          'version.next': 'Next version',
          'dialog.promptTitle': 'Edit prompt',
          'dialog.replyTitle': 'Edit AI reply',
          'dialog.promptWarning': 'Saving regenerates from here and replaces what follows; use ‹ › to view older versions.',
          'dialog.replyWarning': 'Saving shows and feeds your text to the model; later turns stay. Use ‹ › to view the original.',
          'dialog.confirmPrompt': 'Save & regenerate',
          'dialog.confirmReply': 'Save',
          'dialog.cancel': 'Cancel',
          'dialog.saving': 'Working…',
          'dialog.loading': 'Loading…',
          'dialog.dirty': 'Modified',
          'dialog.clean': 'Unchanged',
          'dialog.chars': 'chars',
          'error.failed': 'Edit failed: ',
        },
      }), NS + ': dictionaries')

      try {
        const bound = ctx.locale.bind(NS)
        if (typeof bound === 'function') translate = bound
      } catch { /* keep key passthrough */ }

      // Page-level resources: stylesheets, observer, dialog root.
      ctx.effect(() => {
        const base = document.createElement('style')
        base.setAttribute('data-dshx-message-edit', 'base')
        base.textContent = STYLE_TEXT
        document.head.appendChild(base)
        styleEl = document.createElement('style')
        styleEl.setAttribute('data-dshx-message-edit', 'hidden-turns')
        document.head.appendChild(styleEl)

        const observer = new MutationObserver(scheduleDecorate)
        observer.observe(document.body, { childList: true, subtree: true })
        const unsubscribe = [sessionState, selection, pendingHide].map((store) => store.subscribe(scheduleDecorate))
        const onFocus = () => { for (const id of sessionState.get().keys()) void refresh(id, true) }
        window.addEventListener('focus', onFocus)

        const host = document.createElement('div')
        host.setAttribute('data-dshx-message-edit-root', '')
        document.body.appendChild(host)
        const root = reactDomClient.createRoot(host)
        root.render(h(EditDialog))
        scheduleDecorate()

        return () => {
          observer.disconnect()
          for (const off of unsubscribe) off()
          window.removeEventListener('focus', onFocus)
          root.unmount()
          host.remove()
          base.remove()
          styleEl.remove()
          styleEl = null
          dialog.set(null)
        }
      }, NS + ': page resources')

      // Shadow the Chat's renderers: lower priority renders first. The
      // original's inject face (including `hooks`, which the renderer binds into
      // use* hooks) is forwarded, plus the session id for our own use.
      const injectFor = (key, self) => (...args) => {
        const original = originalEntry(key, self)
        const base = typeof original?.inject === 'function' ? original.inject(...args) : {}
        return { ...base, dshxSessionId: args[0] }
      }
      ctx.slots.inject(NODE_SLOT, () => ctx.slots.register({
        name: NODE_SLOT, key: 'user', priority: -10, locale: 'chat', inject: injectFor('user', UserNode),
      }, UserNode))
      ctx.slots.inject(NODE_SLOT, () => ctx.slots.register({
        name: NODE_SLOT, key: 'assistant-step', priority: -10, locale: 'chat', inject: injectFor('assistant-step', AssistantNode),
      }, AssistantNode))

      // Pen + switcher in the reply's native action row.
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'dshx-message-edit-action',
        order: 20,
        inject: (sessionId) => ({ sessionId }),
      }, ReplyActions))
    }

    return exports
  },
})
