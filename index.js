// dshx-message-edit — host half (v1.3.0).
//
// Two operations on an existing conversation, both verified against the
// 0.2.0-rc.2 host source (not inferred from names):
//
// v1.3.0 — NEVER WRITE PLUGIN-OWNED EVENT TYPES INTO THE SESSION LOG
//
// The host persistence layer refuses to load any session whose log contains an
// event type outside KNOWN_SESSION_EVENT_TYPES unless the event carries the
// envelope marker `ignorable: true` — and `Session.append()` gives plugins no way
// to set that marker. v1.2.0 appended `dshx-message-edit/prompt-edit` and
// `dshx-message-edit/override`, so every edited session became unloadable
// ("contains event type … unknown to this harness and not marked ignorable").
// Now:
//   * the prompt-version link rides on the withdrawn-note `user/message`
//     (a known type) as `source.fromId` / `source.rpcId`;
//   * assistant overrides live in a plugin-owned side file
//     ($DSH_HOME/dshx-message-edit/overrides/<sessionId>.json) and are applied to
//     model requests through the `llm/stream` waterfall, after the host's own
//     request invariants have checked the durable derivation.
// Legacy events from v1.2.0 logs (once repaired to `ignorable: true`) are still
// read, so old edit history keeps rendering.
//
//   edit-prompt     The user rewrites one of their own prompts. Everything from
//                   that prompt to the surface tail is shadowed from the model
//                   with ONE positional replacement, then the corrected prompt
//                   is admitted through the host's own prompt path, which runs
//                   a real turn.
//
//   edit-assistant  The user rewrites the text of one assistant reply. A
//                   plugin-owned event + registered message projection rewrites
//                   the derived message; the durable event is never touched.
//
// HOST CONTRACTS THIS RELIES ON (and why the v1.0.0 code failed)
//
// * Resolving a session: `ctx.agents.resume()` takes an OPTIONS object
//   (`{ resumeSessionId, agentOptions, setup }`), not a string — v1.0.0 passed a
//   string and crashed on every cold session. The host's own resolver,
//   `sessionController.resolveAgent(id)`, also applies the agent preset and
//   model selection, so it is used whenever it exists.
//
// * Regenerating: `agent.wakeDriver()` with an empty inbox opens a turn and
//   immediately closes it as `completed` (agent-loop `turn()`: step 0 with no
//   claimed messages) — no model call. A turn only runs when a message is
//   admitted, so the corrected prompt is sent through
//   `sessionController.prompt()` (fallback: `agent.followup()`).
//
// * The replacement: a `surfaceOp: replace` must cite every shadowed node in
//   `sourceEventSeqs`. The replacing event is a short model-only note
//   (`user/message`, source kind `dshx-message-edit`). The Chat transcript only
//   renders append-origin events, so the note never shows in the UI.
//
// * Assistant edit: only TEXT blocks are replaced. Reasoning and tool-call
//   blocks are kept; dropping a tool-call orphans its tool/result and breaks
//   every later request.
//
// * Projection lifetime: a session that folded an override requires the SAME
//   projection object for later reads. The object is therefore a process-wide
//   singleton, so a plugin reload re-registers the identical definition instead
//   of bricking those sessions.
//
// ROUTES
//
//   GET  /dshx-message-edit/state?sessionId=<id>
//        -> { ok, live, liveUserIds?, overrides: {messageId: [text, …oldest→newest]},
//             promptVersions: [[{id, turn}, …oldest→newest]], maxTurn }
//        Cold sessions are read through sessionController.inspect(), never resumed.
//   GET  /dshx-message-edit/message?sessionId=<id>&messageId=<id>
//        -> { ok, role, text }        full current text (overrides applied)
//   POST /dshx-message-edit/edit-prompt    { sessionId, messageId, text }
//   POST /dshx-message-edit/edit-assistant { sessionId, messageId, text }

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dshx-message-edit'
export const inject = ['webServer', 'sessions', 'agents', 'llm']

const BASE = '/dshx-message-edit'
const MAX_BODY_BYTES = 512 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Legacy (v1.2.0) event types. READ ONLY — never append these again: the host
// refuses to load a log holding an unknown, non-ignorable event type.
const OVERRIDE_EVENT = 'dshx-message-edit/override'
const PROMPT_EDIT_EVENT = 'dshx-message-edit/prompt-edit'
const NOTE_SOURCE_KIND = 'dshx-message-edit'

/** What the model reads in place of the withdrawn prompt and everything after it. */
const WITHDRAWN_NOTE =
  '[The user edited an earlier message. That message and every reply after it were withdrawn; ' +
  'the corrected message follows. Do not refer to the withdrawn content.]'

// ---------------------------------------------------------------------------
// the message projection (process-wide singleton, see header)
// ---------------------------------------------------------------------------

/**
 * Rebuild an assistant message's content with new text, keeping every
 * non-text block (reasoning, tool-call, …) in its original position.
 * @param content - the original content blocks.
 * @param text - the replacement text.
 * @returns the new content array.
 */
function replaceTextBlocks(content, text) {
  const out = []
  let placed = false
  for (const block of Array.isArray(content) ? content : []) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      if (!placed) {
        out.push({ type: 'text', text })
        placed = true
      }
      continue
    }
    out.push(block)
  }
  if (!placed) out.push({ type: 'text', text })
  return out
}

// Legacy projection for v1.2.0 override events. It is still registered so a
// repaired old log (events re-marked `ignorable: true`) keeps deriving the same
// model view, and so live sessions that already folded it keep the SAME object.
const PROJECTION_KEY = Symbol.for('dshx-message-edit/projection@1')
const projection = globalThis[PROJECTION_KEY] ?? (globalThis[PROJECTION_KEY] = Object.freeze({
  type: OVERRIDE_EVENT,
  project(event, input) {
    const messages = new Map()
    const targetSeq = event.data?.targetSeq
    const text = event.data?.text
    if (!Number.isSafeInteger(targetSeq) || typeof text !== 'string') return messages
    const target = input.events[targetSeq - input.baseSeq]
    if (target === undefined || target.type !== 'assistant/message') return messages
    const original = target.data.message
    messages.set(targetSeq, { ...original, content: replaceTextBlocks(original.content, text) })
    return messages
  },
}))

// ---------------------------------------------------------------------------
// assistant-override side store (replaces the v1.2.0 override event)
// ---------------------------------------------------------------------------

/** $DSH_HOME/dshx-message-edit/overrides — the harness reads DSH_HOME first, then ~/.dsh. */
function storeDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'dshx-message-edit', 'overrides')
}

/** sessionId -> { [messageId]: { targetSeq, texts: string[] } } (in-memory cache of the side files). */
const overrideCache = new Map()

/**
 * Read a session's overrides synchronously (the llm/stream waterfall must
 * return its stream synchronously). Missing or corrupt files read as empty.
 */
function readOverrides(sessionId) {
  const cached = overrideCache.get(sessionId)
  if (cached !== undefined) return cached
  let value = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(storeDir(), sessionId + '.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.overrides !== null && typeof parsed.overrides === 'object') {
      for (const [id, entry] of Object.entries(parsed.overrides)) {
        if (entry !== null && typeof entry === 'object' && Number.isSafeInteger(entry.targetSeq) && Array.isArray(entry.texts)) {
          const texts = entry.texts.filter((t) => typeof t === 'string')
          if (texts.length > 0) value[id] = { targetSeq: entry.targetSeq, texts }
        }
      }
    }
  } catch { value = {} }
  overrideCache.set(sessionId, value)
  return value
}

/** Persist one more override text for a message (atomic temp-file + rename). */
function appendOverride(sessionId, messageId, targetSeq, text) {
  const current = readOverrides(sessionId)
  const previous = current[messageId]
  const next = {
    ...current,
    [messageId]: { targetSeq, texts: [...(previous?.targetSeq === targetSeq ? previous.texts : []), text] },
  }
  const dir = storeDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, sessionId + '.json')
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  fs.writeFileSync(temp, JSON.stringify({ version: 1, overrides: next }, null, 2), 'utf8')
  fs.renameSync(temp, file)
  overrideCache.set(sessionId, next)
}

/** Requests this plugin already rewrote and re-dispatched (skip them on the second pass). */
const REWRITTEN = new WeakSet()

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Accept `session-<uuid>` or a bare uuid; return the canonical prefixed id. */
function canonicalId(sessionId) {
  if (typeof sessionId !== 'string') return null
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return UUID.test(bare) ? 'session-' + bare.toLowerCase() : null
}

/** Join a message's text blocks. */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** The message id an event carries, for the two editable event types. */
function messageIdOf(event) {
  if (event?.type === 'user/message') return typeof event.data?.id === 'string' ? event.data.id : null
  if (event?.type === 'assistant/message') return typeof event.data?.message?.id === 'string' ? event.data.message.id : null
  return null
}

export function apply(ctx) {
  const log = (() => {
    try { return typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger } catch { return undefined }
  })()

  /** The host's session controller facade, when this deployment mounts it. */
  const controller = () => {
    try { return ctx.get?.('sessionController') ?? ctx.sessionController } catch { return undefined }
  }

  /**
   * Resolve a live agent for a session, resuming it through the host's own
   * resolver when it is cold.
   */
  async function resolveAgent(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const facade = controller()
    if (facade === undefined || typeof facade.resolveAgent !== 'function') {
      throw new Error('该会话尚未载入，请先在界面中打开它再试。')
    }
    const result = await facade.resolveAgent(sessionId)
    if (result !== null && typeof result === 'object' && 'error' in result) throw new Error(describeError(result.error))
    if (result?.agent === undefined) throw new Error('无法载入会话 ' + sessionId)
    return result.agent
  }

  /** Stop a running turn and wait (bounded) until the loop is idle. */
  async function stopAndSettle(agent) {
    if (agent.status !== 'running') return false
    try { agent.cancel({ kind: 'user' }) } catch { /* raced to idle */ }
    if (typeof agent.whenIdle === 'function') {
      await Promise.race([agent.whenIdle(), new Promise((resolve) => setTimeout(resolve, 15000))])
    }
    return true
  }

  /** Surface node seqs currently visible to the model. */
  const surfaceSeqs = (session) => [...session.surface.nodes]

  /** Locate a surface node by its message id. */
  function findSurfaceNode(session, messageId) {
    const nodes = surfaceSeqs(session)
    for (let index = 0; index < nodes.length; index += 1) {
      const event = session.log[nodes[index]]
      if (messageIdOf(event) === messageId) return { index, seq: nodes[index], event, nodes }
    }
    return null
  }

  /** Highest turn number started in a log. */
  function maxTurnOf(events) {
    let max = 0
    for (const event of events) if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) max = Math.max(max, event.data.turn)
    return max
  }

  /**
   * Edit history per assistant message id: every override text, oldest first
   * (the last one is what the model reads). Targets a later surface
   * replacement shadowed are dropped. Works on a live or a cold log.
   */
  function overridesFromLog(sessionId, events) {
    const shadowed = new Set()
    for (const event of events) {
      if (Array.isArray(event.sourceEventSeqs) && event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
        for (const seq of event.sourceEventSeqs) shadowed.add(seq)
      }
    }
    const out = {}
    // Legacy v1.2.0 events (only present in repaired old logs).
    for (const event of events) {
      if (event.type !== OVERRIDE_EVENT) continue
      const { targetSeq, messageId, text } = event.data ?? {}
      if (!shadowed.has(targetSeq) && typeof messageId === 'string' && typeof text === 'string') (out[messageId] ??= []).push(text)
    }
    // Current side-file store.
    for (const [messageId, entry] of Object.entries(readOverrides(sessionId))) {
      const target = events[entry.targetSeq]
      if (shadowed.has(entry.targetSeq) || messageIdOf(target) !== messageId) continue
      out[messageId] = [...(out[messageId] ?? []), ...entry.texts]
    }
    return out
  }

  /**
   * The override text the model should read for each assistant message still on
   * the surface: messageId -> latest text. Side-file entries win over legacy
   * events (legacy ones are already applied by the registered projection).
   */
  function activeOverrides(session) {
    const stored = readOverrides(session.id)
    const ids = Object.keys(stored)
    if (ids.length === 0) return null
    const visible = new Set(session.surface.nodes)
    const out = new Map()
    for (const messageId of ids) {
      const entry = stored[messageId]
      if (!visible.has(entry.targetSeq) || messageIdOf(session.log[entry.targetSeq]) !== messageId) continue
      out.set(messageId, entry.texts[entry.texts.length - 1])
    }
    return out.size > 0 ? out : null
  }

  /**
   * Prompt edit history for the GPT-style version switcher.
   *
   * Each withdrawn-note `user/message` (source kind `dshx-message-edit`) links
   * the withdrawn prompt (`source.fromId`) to its successor (`source.rpcId`,
   * which becomes the successor's `source.rpcId`). Legacy v1.2.0 logs carry the
   * same link in a `dshx-message-edit/prompt-edit` event. Chains collapse to
   * groups ordered oldest -> newest; each version carries the turn it opened so
   * the client can hide the whole branch.
   */
  function promptVersionsOf(events) {
    const idByRpc = new Map()
    const turnById = new Map()
    let currentTurn
    for (const event of events) {
      if (event.type === 'turn/start') currentTurn = event.data?.turn
      if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data?.source?.kind === 'user') {
        turnById.set(event.data.id, currentTurn)
        if (typeof event.data.source.rpcId === 'string') idByRpc.set(event.data.source.rpcId, event.data.id)
      }
    }
    const next = new Map()
    for (const event of events) {
      let link
      if (event.type === PROMPT_EDIT_EVENT) link = event.data
      else if (event.type === 'user/message' && event.data?.source?.kind === NOTE_SOURCE_KIND) link = event.data.source
      if (link === undefined) continue
      const successor = idByRpc.get(link?.rpcId)
      if (typeof link?.fromId === 'string' && successor !== undefined) next.set(link.fromId, successor)
    }
    const hasPredecessor = new Set(next.values())
    const groups = []
    for (const head of next.keys()) {
      if (hasPredecessor.has(head)) continue
      const ids = [head]
      const seen = new Set(ids)
      while (next.has(ids[ids.length - 1]) && !seen.has(next.get(ids[ids.length - 1]))) {
        const id = next.get(ids[ids.length - 1])
        ids.push(id)
        seen.add(id)
      }
      groups.push(ids.map((id) => ({ id, turn: turnById.get(id) ?? null })))
    }
    return groups
  }

  // -------------------------------------------------------------------------
  // projection registration
  // -------------------------------------------------------------------------

  ctx.effect(() => ctx.sessions.registerMessageProjection(projection), name + ': message projection')

  // -------------------------------------------------------------------------
  // model-side assistant overrides (llm/stream waterfall)
  // -------------------------------------------------------------------------
  //
  // Host facts this relies on (0.2.0-rc.2 source):
  // * cordis `waterfall` hands every listener the SAME arguments; `next()` takes
  //   none, so a listener cannot pass modified options down the chain. To send
  //   rewritten messages we re-dispatch through `ctx.llm.stream(rewritten)` and
  //   do not call `next()`.
  // * The agent-loop invariant (`global`, `prepend`) runs before us and checks
  //   that the ORIGINAL request equals `session.deriveMessages()` — which still
  //   holds, since we never touch the log. The re-dispatched copy is a fresh
  //   object, so it is not an "agent-loop request" and that check skips it.
  ctx.on('llm/stream', (options, next) => {
    if (REWRITTEN.has(options) || options?.sessionId === undefined || !Array.isArray(options.messages)) return next()
    let session
    try { session = ctx.sessions.get(options.sessionId) } catch { session = undefined }
    if (session === undefined) return next()
    let overrides
    try { overrides = activeOverrides(session) } catch { overrides = null }
    if (overrides === null) return next()
    let changed = false
    const messages = options.messages.map((message) => {
      if (message?.role !== 'assistant' || !overrides.has(message.id)) return message
      changed = true
      return Object.freeze({ ...message, content: Object.freeze(replaceTextBlocks(message.content, overrides.get(message.id))) })
    })
    if (!changed) return next()
    const rewritten = Object.freeze({ ...options, messages: Object.freeze(messages) })
    REWRITTEN.add(rewritten)
    return ctx.llm.stream(rewritten)
  }, { global: true })

  // -------------------------------------------------------------------------
  // routes
  // -------------------------------------------------------------------------

  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  const queryOf = (req) => Object.fromEntries(new URL(req.url ?? '/', 'http://dsh.internal').searchParams)

  const bodyOf = async (req) => {
    const parsed = JSON.parse(await readBody(req))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  }

  const route = (path, method, handler, label) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + path,
    handler: async (req, res) => {
      try {
        if ((req.method ?? 'GET') !== method) return json(res, 405, { error: 'method not allowed' })
        const payload = method === 'GET' ? queryOf(req) : await bodyOf(req)
        const sessionId = canonicalId(payload.sessionId)
        if (sessionId === null) return json(res, 400, { error: '缺少或非法的 sessionId' })
        await handler({ payload, sessionId, res })
      } catch (error) {
        json(res, 500, { error: describeError(error) })
      }
    },
  }), name + ': ' + label)

  // State is read-only: it never resumes a cold session.
  route('/state', 'GET', async ({ sessionId, res }) => {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      // Cold: read the log without resuming an agent, so edit history still renders.
      let events = []
      try {
        const inspected = await controller()?.inspect?.(sessionId, new AbortController().signal)
        if (Array.isArray(inspected?.events)) events = inspected.events
      } catch { /* unknown session: empty state */ }
      return json(res, 200, { ok: true, live: false, overrides: overridesFromLog(sessionId, events), promptVersions: promptVersionsOf(events), maxTurn: maxTurnOf(events) })
    }
    const liveUserIds = []
    for (const seq of surfaceSeqs(session)) {
      const event = session.log[seq]
      if (event?.type === 'user/message' && typeof event.data?.id === 'string') liveUserIds.push(event.data.id)
    }
    json(res, 200, { ok: true, live: true, liveUserIds, overrides: overridesFromLog(sessionId, session.log), promptVersions: promptVersionsOf(session.log), maxTurn: maxTurnOf(session.log) })
  }, 'state')

  route('/message', 'GET', async ({ payload, sessionId, res }) => {
    if (typeof payload.messageId !== 'string' || payload.messageId.length === 0) return json(res, 400, { error: '缺少 messageId' })
    const session = ctx.sessions.get(sessionId) ?? (await resolveAgent(sessionId)).session
    for (let index = session.log.length - 1; index >= 0; index -= 1) {
      const event = session.log[index]
      if (messageIdOf(event) !== payload.messageId) continue
      const message = session.surface.deriveEventMessage(event) ?? (event.type === 'user/message' ? event.data : event.data.message)
      const stored = event.type === 'assistant/message' ? readOverrides(sessionId)[payload.messageId] : undefined
      const text = stored !== undefined && stored.targetSeq === event.seq ? stored.texts[stored.texts.length - 1] : textOf(message)
      return json(res, 200, { ok: true, role: message.role, text })
    }
    json(res, 404, { error: '找不到该消息' })
  }, 'message')

  route('/edit-prompt', 'POST', async ({ payload, sessionId, res }) => {
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (text.trim().length === 0) return json(res, 400, { error: '修正后的提示词不能为空' })
    if (typeof payload.messageId !== 'string') return json(res, 400, { error: '缺少 messageId' })

    const agent = await resolveAgent(sessionId)
    const cancelled = await stopAndSettle(agent)
    const session = agent.session

    const found = findSurfaceNode(session, payload.messageId)
    if (found === null) return json(res, 409, { error: '这条提示词已不在模型可见的历史中（可能已被修正或压缩）。' })
    if (found.event.type !== 'user/message' || found.event.data?.source?.kind !== 'user') {
      return json(res, 400, { error: '只能修正你自己发送的提示词。' })
    }
    if (found.index === 0) return json(res, 400, { error: '不能替换会话的第一个节点。' })

    // Fold a directly preceding note from an earlier edit into this range, so
    // repeated edits leave exactly one note instead of stacking them.
    let first = found.index
    const previous = session.log[found.nodes[first - 1]]
    if (first > 1 && previous?.type === 'user/message' && previous.data?.source?.kind === NOTE_SOURCE_KIND) first -= 1

    const shadowed = found.nodes.slice(first)
    const startSeq = shadowed[0]
    const endSeq = shadowed[shadowed.length - 1]

    // The note itself carries the version link (withdrawn prompt `fromId` ->
    // successor whose `source.rpcId` equals this `rpcId` on both resend paths).
    // It is a known event type, so the log stays loadable by the host.
    const rpcId = randomUUID()
    let fromTurn = null
    for (const event of session.log) {
      if (event.seq >= found.seq) break
      if (event.type === 'turn/start') fromTurn = event.data?.turn ?? null
    }
    const withdrawnTurns = { from: fromTurn, to: maxTurnOf(session.log) }
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: WITHDRAWN_NOTE }],
      source: { kind: NOTE_SOURCE_KIND, fromId: payload.messageId, rpcId },
    }, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: shadowed,
    })

    // Admit the corrected prompt as a real user turn so the model runs.
    let sent = 'none'
    const facade = controller()
    try {
      if (facade !== undefined && typeof facade.prompt === 'function') {
        await facade.prompt({ sessionId, content: [{ type: 'text', text }], requestId: rpcId }, new AbortController().signal)
        sent = 'controller'
      } else {
        agent.followup(Object.freeze({
          id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId },
        }))
        sent = 'followup'
      }
    } catch (error) {
      log?.warn?.('prompt edit recorded but resend failed: %s', describeError(error))
      return json(res, 502, {
        error: '旧提示词已撤回，但重新发送失败：' + describeError(error) + '。请直接在输入框发送修正后的内容。',
      })
    }

    log?.info?.('edited prompt in %s: replaced [%d..%d] (%d nodes), resend=%s', sessionId, startSeq, endSeq, shadowed.length, sent)
    json(res, 200, { ok: true, replaced: { startSeq, endSeq, shadowed: shadowed.length }, withdrawnTurns, cancelled, sent })
  }, 'edit-prompt')

  route('/edit-assistant', 'POST', async ({ payload, sessionId, res }) => {
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (text.trim().length === 0) return json(res, 400, { error: '修正后的内容不能为空' })
    if (typeof payload.messageId !== 'string') return json(res, 400, { error: '缺少 messageId' })

    const agent = await resolveAgent(sessionId)
    const cancelled = await stopAndSettle(agent)
    const session = agent.session

    const found = findSurfaceNode(session, payload.messageId)
    if (found === null) return json(res, 409, { error: '这条回复已不在模型可见的历史中（可能已被替换或压缩）。' })
    if (found.event.type !== 'assistant/message') return json(res, 400, { error: '只能修改 AI 回复。' })

    // Side file, not a session event: the log must stay loadable by the host.
    appendOverride(sessionId, payload.messageId, found.seq, text)
    log?.info?.('overrode assistant message %s in %s (seq %d)', payload.messageId, sessionId, found.seq)
    json(res, 200, { ok: true, overridden: { seq: found.seq, messageId: payload.messageId }, cancelled })
  }, 'edit-assistant')
}
