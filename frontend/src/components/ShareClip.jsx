import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { apiOrigin } from '../lib/socket'

// Delay (in milliseconds) of inactivity before saving draft to MongoDB
const SAVE_DELAY_MS = 400

// Regular expression to identify HTTP and HTTPS links in the draft
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi

/**
 * Extracts and deduplicates all valid HTTP/HTTPS URLs from raw text content.
 *
 * @param {string} value - Text content from textarea.
 * @returns {string[]} Array of unique URL strings.
 */
function extractLinks(value) {
  if (!value) return []
  return [...new Set(value.match(URL_PATTERN) || [])]
}

/**
 * ShareClip Component
 *
 * @param {Object} props
 * @param {string} props.roomCode - Active 4-digit room code (e.g., "8492").
 * @param {'host' | 'guest'} [props.role='guest'] - Role of current device.
 * @param {import('socket.io-client').Socket} [props.socket=null] - Shared session socket.
 */
export default function ShareClip({ roomCode, role = 'guest', socket: externalSocket = null }) {
  // Local state for the textarea content
  const [text, setText] = useState('')
  // Feedback notice banner ("Saved", "Saving...", "Updated from other device")
  const [notice, setNotice] = useState('Connecting…')
  const [noticeTone, setNoticeTone] = useState('muted') // 'muted' | 'ok' | 'error'
  // Transient copy feedback state
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedLinkIndex, setCopiedLinkIndex] = useState(null)

  // Ref tracking the latest text content without triggering effect re-subscriptions
  const textRef = useRef('')
  // Ref holding the active Socket.io instance
  const socketRef = useRef(null)
  // Ref holding the active debounce timer ID
  const saveTimerRef = useRef(null)
  // Monotonic sequence token ensuring out-of-order REST responses are safely dropped
  const saveSeqRef = useRef(0)

  // Unique identifier for this client session to enable echo cancellation:
  // The server echoes clientId on broadcasts so this client can ignore its own echo.
  const clientIdRef = useRef(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `client-${Date.now()}-${Math.floor(Math.random() * 100000)}`
  )

  /**
   * ===========================================================================
   * EFFECT 1: SOCKET.IO LIFECYCLE & INBOUND NETWORK MESSAGE LISTENERS
   * ===========================================================================
   * Listens for inbound live messages and server-persisted clip broadcasts.
   *
   * CRITICAL ANTI-LOOP RULE:
   * Notice this effect has ZERO dependencies on `text`. It depends ONLY on
   * `[roomCode, role, externalSocket]`. It does NOT re-subscribe when `text`
   * changes. Inbound network packets update `textRef` and call `setText()`,
   * but NEVER trigger outgoing broadcasts or saves.
   */
  useEffect(() => {
    const ownsSocket = !externalSocket
    const socket =
      externalSocket ||
      io(apiOrigin || undefined, {
        transports: ['websocket', 'polling'],
      })
    socketRef.current = socket

    const doJoin = () => {
      // If using the shared session socket from HomeScreen, it is already joined.
      if (externalSocket) {
        setNotice('Connected')
        setNoticeTone('muted')
        return
      }

      socket.emit(
        'join-room',
        { roomCode, create: role === 'host' },
        (response) => {
          if (response?.success) {
            setNotice(response.created ? 'Room open' : 'Connected')
            setNoticeTone('muted')
            return
          }
          // Guard against benign race conditions where another component joined first
          if (response?.message && /already in room/i.test(response.message)) {
            setNotice('Connected')
            setNoticeTone('muted')
            return
          }
          setNotice(response?.message || 'Could not join room.')
          setNoticeTone('error')
        }
      )
    }

    const onConnect = () => {
      doJoin()
    }

    if (socket.connected) {
      doJoin()
    } else {
      socket.on('connect', onConnect)
    }

    /**
     * Applies remote text edits into the local textarea.
     *
     * LOOP BREAKERS:
     * 1. Echo Cancellation: Discards messages originating from this browser tab.
     * 2. Idempotency Check: Discards if content matches existing text in `textRef`.
     * 3. One-Way Write: Does NOT invoke `saveClip()` or `publishLive()`.
     */
    const applyRemote = (content, clientId) => {
      // 1. Drop our own echoed broadcast
      if (clientId && clientId === clientIdRef.current) return
      // 2. Drop no-op identical content
      if (content === textRef.current) return

      // 3. Apply state and ref updates safely
      textRef.current = content
      setText(content)
      setNotice('Updated from the other device')
      setNoticeTone('ok')
    }

    // Handler for real-time keystroke broadcasts relayed over Socket.io
    const onLiveMessage = (payload) => {
      const data = payload?.data
      if (!data || data.type !== 'clip') return
      applyRemote(String(data.content ?? ''), data.clientId)
    }

    // Handler for REST-persisted clip broadcasts emitted by the backend
    const onSavedClip = (payload) => {
      if (!payload || payload.roomCode !== roomCode) return
      applyRemote(String(payload.content ?? ''), payload.clientId)
    }

    const onConnectError = () => {
      setNotice('Live connection interrupted. Drafts save to server when reachable.')
      setNoticeTone('error')
    }

    socket.on('message', onLiveMessage)
    socket.on('clip-received', onSavedClip)
    socket.on('connect_error', onConnectError)

    return () => {
      window.clearTimeout(saveTimerRef.current)
      socket.off('connect', onConnect)
      socket.off('message', onLiveMessage)
      socket.off('clip-received', onSavedClip)
      socket.off('connect_error', onConnectError)

      // Only disconnect if this component created its own dedicated socket instance
      if (ownsSocket) {
        try {
          socket.emit('leave-room', { roomCode })
          socket.disconnect()
        } catch {}
      }
      socketRef.current = null
    }
  }, [roomCode, role, externalSocket])

  /**
   * ===========================================================================
   * EFFECT 2: INITIAL REST HYDRATION (FETCH LATEST STORED CLIP)
   * ===========================================================================
   * Loads the existing saved draft from MongoDB Atlas when the room mounts.
   * Uses AbortController to cleanly cancel in-flight HTTP requests on unmount.
   */
  useEffect(() => {
    const controller = new AbortController()

    async function loadInitialClip() {
      try {
        const response = await fetch(`${apiOrigin}/api/clip/${roomCode}`, {
          signal: controller.signal,
        })
        if (response.status === 404) return // No clip saved yet: keep clean textarea
        if (!response.ok) return

        const body = await response.json()
        const latest = body?.data?.[0]?.content
        if (typeof latest !== 'string') return

        // Guard: If the user already started typing before the fetch returned,
        // do NOT overwrite their live typing with the older database record!
        if (textRef.current.length > 0) return

        textRef.current = latest
        setText(latest)
      } catch (error) {
        if (error.name === 'AbortError') return
        console.warn('[ShareClip] Could not load stored clip:', error)
      }
    }

    loadInitialClip()
    return () => controller.abort()
  }, [roomCode])

  /**
   * Broadcasts the current text immediately across the Socket.io WebSocket pipe.
   * This provides instant sub-millisecond character updates to the peer.
   *
   * @param {string} content - Current textarea text.
   */
  function publishLive(content) {
    const socket = socketRef.current
    if (!socket?.connected) return
    socket.emit('message', {
      roomCode,
      data: {
        type: 'clip',
        content,
        clientId: clientIdRef.current,
      },
    })
  }

  /**
   * Persists the current draft to MongoDB Atlas via the Express REST API.
   *
   * @param {string} content - Text content to persist.
   * @param {number} seq - Sequence number when this save was scheduled.
   */
  async function saveClip(content, seq) {
    if (!content.trim()) return

    setNotice('Saving…')
    setNoticeTone('muted')

    try {
      const response = await fetch(`${apiOrigin}/api/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode,
          content,
          clientId: clientIdRef.current,
        }),
      })

      // Stale response guard: If the user typed another character while this HTTP
      // request was traveling over the wire, discard this response.
      if (seq !== saveSeqRef.current) return

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        setNotice(body?.error?.message || 'Could not save.')
        setNoticeTone('error')
        return
      }

      setNotice('Saved to cloud')
      setNoticeTone('ok')
    } catch {
      if (seq !== saveSeqRef.current) return
      setNotice('Could not reach cloud storage.')
      setNoticeTone('error')
    }
  }

  /**
   * ===========================================================================
   * USER INPUT HANDLER: DOM ONCHANGE (EVENT-DRIVEN ARCHITECTURE)
   * ===========================================================================
   * Fired exclusively when the local user types, pastes, or edits text in the textarea.
   *
   * DEBOUNCING MECHANISM:
   * 1. Updates state and ref immediately for seamless 60fps typing UI.
   * 2. Immediately broadcasts character to peer via WebSocket (`publishLive`).
   * 3. Cancels any pending debounced timer (`clearTimeout`).
   * 4. Schedules a single HTTP POST `SAVE_DELAY_MS` (400ms) into the future.
   *
   * Why this eliminates infinite render loops:
   * - Inbound remote messages DO NOT pass through `handleChange`.
   * - Only physical user keyboard events trigger `saveClip` and `publishLive`.
   */
  function handleChange(event) {
    const next = event.target.value
    textRef.current = next
    setText(next)

    // 1. Instant real-time broadcast to peer
    publishLive(next)

    // 2. Debounce the MongoDB Atlas REST write
    window.clearTimeout(saveTimerRef.current)
    const seq = saveSeqRef.current + 1
    saveSeqRef.current = seq

    saveTimerRef.current = window.setTimeout(() => {
      saveClip(next, seq)
    }, SAVE_DELAY_MS)
  }

  // Copy entire text draft to user's system clipboard
  async function handleCopyAll() {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 2000)
    } catch {
      setNotice('Clipboard access denied.')
      setNoticeTone('error')
    }
  }

  // Copy an individual extracted URL to user's system clipboard
  async function handleCopyLink(link, index) {
    try {
      await navigator.clipboard.writeText(link)
      setCopiedLinkIndex(index)
      setTimeout(() => setCopiedLinkIndex(null), 2000)
    } catch {
      setNotice('Could not copy link.')
      setNoticeTone('error')
    }
  }

  // Parse extracted links from current draft
  const links = extractLinks(text)
  const charCount = text.length
  const MAX_SAFE_CHARS = 50000

  return (
    <section className="flex flex-col gap-3">
      {/* Header with Title and Live Sync/Save Status Indicator */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-stone-900">Shared clipboard</h2>
          <span className="text-xs text-stone-400">· Real-time sync</span>
        </div>

        <div className="flex items-center gap-2">
          {/* Animated dot indicator for active sync status */}
          <span
            className={`inline-block h-2 w-2 rounded-full transition-colors ${
              noticeTone === 'error'
                ? 'bg-red-500'
                : noticeTone === 'ok'
                  ? 'bg-emerald-500'
                  : 'bg-stone-400'
            }`}
            aria-hidden="true"
          />
          <p
            className={`text-xs font-medium transition-colors ${
              noticeTone === 'error'
                ? 'text-red-700'
                : noticeTone === 'ok'
                  ? 'text-emerald-700'
                  : 'text-stone-500'
            }`}
            role="status"
          >
            {notice}
          </p>
        </div>
      </div>

      {/* Main Collaborative Textarea */}
      <div className="relative">
        <textarea
          value={text}
          onChange={handleChange}
          rows={6}
          maxLength={MAX_SAFE_CHARS}
          placeholder="Type notes or paste links here. Changes broadcast instantly to connected devices and auto-save..."
          aria-label="Collaborative shared text and links"
          className="w-full resize-y rounded-xl border border-stone-300 bg-white px-4 py-3 text-sm leading-relaxed text-stone-950 outline-none transition-colors placeholder:text-stone-400 focus:border-stone-950"
        />

        {/* Copy All button overlay */}
        {text ? (
          <button
            type="button"
            onClick={handleCopyAll}
            aria-label="Copy entire text to clipboard"
            className="absolute top-2.5 right-2.5 rounded-lg border border-stone-200 bg-white/90 px-2.5 py-1 text-xs font-medium text-stone-700 shadow-sm backdrop-blur-sm transition-colors hover:border-stone-400 hover:text-stone-950"
          >
            {copiedAll ? '✓ Copied' : 'Copy all'}
          </button>
        ) : null}
      </div>

      {/* Character count and length status */}
      <div className="flex items-center justify-between text-xs text-stone-500">
        <span>Auto-saves 400ms after typing pauses</span>
        <span className="font-mono">
          {charCount.toLocaleString()} / {MAX_SAFE_CHARS.toLocaleString()}
        </span>
      </div>

      {/* Extracted Clickable Links Section */}
      {links.length > 0 ? (
        <div className="mt-1 flex flex-col gap-2 rounded-xl border border-stone-200 bg-white p-3.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Detected Links ({links.length})
            </h3>
            <span className="text-[11px] text-stone-400">Click to open or copy</span>
          </div>

          <ul className="flex flex-col gap-1.5" role="list">
            {links.map((link, idx) => (
              <li
                key={`${link}-${idx}`}
                className="flex items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2 text-xs transition-colors hover:bg-stone-100"
              >
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-stone-800 underline decoration-stone-300 underline-offset-4 hover:text-stone-950"
                  title={link}
                >
                  {link}
                </a>

                <button
                  type="button"
                  onClick={() => handleCopyLink(link, idx)}
                  className="shrink-0 rounded border border-stone-200 bg-white px-2 py-0.5 text-[11px] font-medium text-stone-600 transition-colors hover:border-stone-400 hover:text-stone-950"
                >
                  {copiedLinkIndex === idx ? '✓ Copied' : 'Copy'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
