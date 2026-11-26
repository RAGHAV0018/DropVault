import { useEffect, useRef, useState } from 'react'
import { generateRoomCode, isRoomCode } from '../lib/roomCode'
import { createSessionSocket } from '../lib/socket'
import { createPeerConnection, createSenderDataChannel } from '../lib/webrtcPeer'
import {
  addRemoteIceCandidate,
  createAndSendOffer,
  receiveAnswer,
  receiveOfferAndSendAnswer,
} from '../lib/signaling'
import { createFileReceiver } from '../lib/fileTransfer'
import GeneratePanel from './GeneratePanel'
import JoinPanel from './JoinPanel'
import ShareClip from './ShareClip'
import FileDropZone from './FileDropZone'
import RoomQrCode from './RoomQrCode'

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export default function HomeScreen() {
  const [hostCode, setHostCode] = useState(null)
  const [joinInput, setJoinInput] = useState('')
  const [session, setSession] = useState(null)
  const [status, setStatus] = useState(null)

  const [socket, setSocket] = useState(null)
  const [rtcState, setRtcState] = useState('idle')
  const [dataChannel, setDataChannel] = useState(null)
  const [incomingFile, setIncomingFile] = useState(null)

  const peerRef = useRef(null)
  const dataChannelRef = useRef(null)
  const pendingCandidatesRef = useRef([])
  const fileReceiverCleanupRef = useRef(null)
  const makingOfferRef = useRef(false)

  // Auto-join if user scanned a QR code or opened a link with ?room=XXXX or ?code=XXXX
  useEffect(() => {
    try {
      const searchParams = new URLSearchParams(window.location.search)
      const queryCode = (searchParams.get('room') || searchParams.get('code') || '').trim()
      if (isRoomCode(queryCode)) {
        setJoinInput(queryCode)
        setSession({ code: queryCode, role: 'guest' })
        setStatus({ tone: 'ok', message: `Joining room ${queryCode} from URL...` })
      }
    } catch (err) {
      console.warn('[HomeScreen] Could not parse query params:', err)
    }
  }, [])

  // Sync browser tab title with active room
  useEffect(() => {
    document.title = session ? `DropVault · ${session.code}` : 'DropVault'
  }, [session])

  // Transient status notification timer with cleanup
  useEffect(() => {
    if (!status) return undefined
    const timeoutId = window.setTimeout(() => setStatus(null), 4000)
    return () => window.clearTimeout(timeoutId)
  }, [status])

  function cleanupWebRTC({ keepSocket = true } = {}) {
    if (fileReceiverCleanupRef.current) {
      try { fileReceiverCleanupRef.current() } catch {}
      fileReceiverCleanupRef.current = null
    }
    const ch = dataChannelRef.current
    if (ch) {
      try { ch.close() } catch {}
    }
    dataChannelRef.current = null
    setDataChannel(null)

    const pc = peerRef.current
    if (pc) {
      try { pc.onicecandidate = null } catch {}
      try { pc.ondatachannel = null } catch {}
      try { pc.onconnectionstatechange = null } catch {}
      try { pc.close() } catch {}
    }
    peerRef.current = null
    pendingCandidatesRef.current = []
    makingOfferRef.current = false
    setRtcState(keepSocket ? 'waiting' : 'idle')
    setIncomingFile(null)
  }

  function attachDataChannel(channel) {
    if (!channel) return

    // Clean up previous listeners
    if (fileReceiverCleanupRef.current) {
      try { fileReceiverCleanupRef.current() } catch {}
      fileReceiverCleanupRef.current = null
    }

    // CRITICAL: Force binaryType to 'arraybuffer'. Default is 'blob' in browsers.
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = 1024 * 1024 // 1 MB drain threshold

    dataChannelRef.current = channel
    setDataChannel(channel)

    // Attach chunk receiver for incoming file transfers
    const handleIncoming = createFileReceiver({
      onMetadataReceived: (meta) => {
        setIncomingFile({
          name: meta?.name || 'file',
          percent: 0,
          bytes: 0,
          total: meta?.size || 0,
          done: false,
          error: null,
        })
      },
      onProgress: (percent, receivedBytes, totalBytes) => {
        setIncomingFile((prev) => ({
          ...(prev || {}),
          percent: Math.min(100, Math.max(0, Math.round(percent || 0))),
          bytes: receivedBytes || 0,
          total: totalBytes || prev?.total || 0,
          done: false,
        }))
      },
      onFileComplete: ({ fileName, downloadUrl, size }) => {
        // Trigger browser file download via hidden <a> element
        const a = document.createElement('a')
        a.href = downloadUrl
        a.download = fileName || 'download'
        document.body.appendChild(a)
        a.click()
        a.remove()

        // Revoke Object URL after short delay to prevent browser memory leaks
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000)

        setIncomingFile((prev) =>
          prev
            ? { ...prev, percent: 100, done: true, total: size || prev.total }
            : null
        )
      },
      onError: (err) => {
        console.error('[WebRTC:FileReceiver] Error:', err)
        setIncomingFile((prev) =>
          prev ? { ...prev, error: err?.message || 'File receive failed' } : null
        )
      },
    })

    const onMessage = (event) => handleIncoming(event)
    const onOpen = () => {
      console.log(`[WebRTC:DataChannel] DataChannel '${channel.label}' opened!`)
      setRtcState('connected')
      setDataChannel(channel)
    }
    const onClose = () => {
      console.log(`[WebRTC:DataChannel] DataChannel '${channel.label}' closed.`)
      setRtcState('waiting')
      if (dataChannelRef.current === channel) {
        dataChannelRef.current = null
        setDataChannel(null)
      }
    }
    const onError = (error) => {
      console.error(`[WebRTC:DataChannel] Error on '${channel.label}':`, error)
    }

    channel.addEventListener('message', onMessage)
    channel.addEventListener('open', onOpen)
    channel.addEventListener('close', onClose)
    channel.addEventListener('error', onError)

    if (channel.readyState === 'open') {
      setRtcState('connected')
    }

    fileReceiverCleanupRef.current = () => {
      channel.removeEventListener('message', onMessage)
      channel.removeEventListener('open', onOpen)
      channel.removeEventListener('close', onClose)
      channel.removeEventListener('error', onError)
    }
  }

  // Session-scoped Socket.io + WebRTC signaling lifecycle
  useEffect(() => {
    if (!session) return undefined

    const s = createSessionSocket()
    setSocket(s)
    setRtcState('connecting')
    pendingCandidatesRef.current = []
    makingOfferRef.current = false

    // Perfect negotiation rule: Guest is the polite peer
    const isPolite = session.role === 'guest'

    const ensurePeer = () => {
      if (peerRef.current) return peerRef.current
      const pc = createPeerConnection({
        socket: s,
        roomCode: session.code,
        onConnectionStateChange: (state) => {
          console.log(`[WebRTC:PeerConnection] State changed to: ${state}`)
          if (state === 'connected') {
            setRtcState('connected')
          } else if (state === 'failed' || state === 'disconnected') {
            setRtcState('waiting')
          }
        },
        onDataChannel: (incomingChannel) => {
          // Guest receives the data channel instantiated by the Host
          console.log('[WebRTC:DataChannel] Remote data channel received via ondatachannel event.')
          attachDataChannel(incomingChannel)
        },
      })
      peerRef.current = pc
      return pc
    }

    const flushPendingCandidates = async () => {
      const pc = peerRef.current
      if (!pc || !pc.remoteDescription) return
      const queued = pendingCandidatesRef.current.splice(0, pendingCandidatesRef.current.length)
      for (const candidate of queued) {
        await addRemoteIceCandidate(pc, candidate)
      }
    }

    const startOfferToPeer = async () => {
      if (makingOfferRef.current) return
      try {
        makingOfferRef.current = true
        const pc = ensurePeer()

        // Create the sender data channel before offer creation
        if (!dataChannelRef.current) {
          const ch = createSenderDataChannel(pc)
          attachDataChannel(ch)
        }

        await createAndSendOffer(pc, s, session.code)
        await flushPendingCandidates()
      } catch (err) {
        console.error('[WebRTC] Failed to create/send offer:', err)
      } finally {
        makingOfferRef.current = false
      }
    }

    const onConnect = () => {
      s.emit('join-room', { roomCode: session.code, create: session.role === 'host' }, (res) => {
        if (!res?.success) {
          if (res?.message && /already in room/i.test(res.message)) return
          setStatus({ tone: 'error', message: res.message || 'Could not join room.' })
          return
        }

        // Deterministic offer rule:
        // Only initiate offer if host AND a peer is already waiting, OR wait for peer-joined
        if (session.role === 'host' && res.peerId) {
          startOfferToPeer()
        } else {
          setRtcState('waiting')
        }
      })
    }

    const onPeerJoined = async () => {
      // Existing peer (the Host) initiates the offer when the new peer arrives
      console.log('[WebRTC] Remote peer joined room. Initiating SDP offer...')
      await startOfferToPeer()
    }

    const onPeerLeft = () => {
      console.log('[WebRTC] Remote peer left room.')
      cleanupWebRTC({ keepSocket: true })
      setRtcState('waiting')
    }

    const onOffer = async (payload) => {
      try {
        const offer = payload?.offer || payload
        if (!offer) return
        const pc = ensurePeer()

        // PERFECT NEGOTIATION (RFC 8829) OFFER GLARE RESOLUTION:
        // If an offer arrives while we already generated a local offer:
        const isCollision =
          makingOfferRef.current || pc.signalingState !== 'stable'

        if (isCollision) {
          if (!isPolite) {
            // Impolite peer (Host): ignore incoming glare offer, let polite peer yield
            console.log('[WebRTC:Signaling] Glare detected. Impolite peer ignoring remote offer.')
            return
          }
          // Polite peer (Guest): roll back local offer and accept remote offer
          console.log('[WebRTC:Signaling] Glare detected. Polite peer rolling back to accept remote offer.')
          await pc.setRemoteDescription({ type: 'rollback' })
        }

        await receiveOfferAndSendAnswer(pc, s, session.code, offer)
        await flushPendingCandidates()
      } catch (err) {
        console.error('[WebRTC] Failed handling offer:', err)
      }
    }

    const onAnswer = async (payload) => {
      try {
        const answer = payload?.answer || payload
        if (!answer) return
        const pc = peerRef.current
        if (!pc) return
        await receiveAnswer(pc, answer)
        await flushPendingCandidates()
      } catch (err) {
        console.error('[WebRTC] Failed handling answer:', err)
      }
    }

    const onIceCandidate = async (payload) => {
      try {
        const candidate = payload?.candidate
        if (!candidate) return
        const pc = peerRef.current
        if (!pc || !pc.remoteDescription) {
          pendingCandidatesRef.current.push(candidate)
          return
        }
        await addRemoteIceCandidate(pc, candidate)
      } catch (err) {
        console.error('[WebRTC] Failed adding ICE candidate:', err)
      }
    }

    s.on('connect', onConnect)
    s.on('peer-joined', onPeerJoined)
    s.on('peer-left', onPeerLeft)
    s.on('webrtc-offer', onOffer)
    s.on('webrtc-answer', onAnswer)
    s.on('ice-candidate', onIceCandidate)

    if (s.connected) onConnect()

    return () => {
      s.off('connect', onConnect)
      s.off('peer-joined', onPeerJoined)
      s.off('peer-left', onPeerLeft)
      s.off('webrtc-offer', onOffer)
      s.off('webrtc-answer', onAnswer)
      s.off('ice-candidate', onIceCandidate)

      try { s.emit('leave-room', { roomCode: session.code }) } catch {}
      cleanupWebRTC({ keepSocket: false })
      try { s.disconnect() } catch {}
      setSocket(null)
    }
  }, [session])

  function handleGenerate() {
    const code = generateRoomCode()
    setHostCode(code)
    setSession({ code, role: 'host' })
    setStatus({ tone: 'ok', message: 'Room code created. Share with your peer!' })
  }

  function handleJoinChange(event) {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 4)
    setJoinInput(digits)
  }

  function handleJoin(event) {
    event.preventDefault()
    if (!isRoomCode(joinInput)) {
      setStatus({ tone: 'error', message: 'Please enter a valid 4-digit code.' })
      return
    }
    setSession({ code: joinInput, role: 'guest' })
    setStatus({ tone: 'ok', message: `Connected to room ${joinInput}.` })
  }

  function handleLeave() {
    setSession(null)
    setStatus(null)
  }

  const rtcLabel =
    rtcState === 'connected'
      ? 'P2P connected'
      : rtcState === 'connecting'
        ? 'Connecting peers...'
        : rtcState === 'waiting'
          ? 'Waiting for peer...'
          : 'Offline'

  const rtcBadgeColor =
    rtcState === 'connected'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
      : rtcState === 'connecting'
        ? 'bg-amber-100 text-amber-800 border-amber-300'
        : 'bg-stone-100 text-stone-600 border-stone-200'

  return (
    <div className="min-h-svh bg-[#f4f1ea] text-stone-900">
      <div className="mx-auto flex min-h-svh w-full max-w-lg flex-col px-5 py-10 sm:px-6 sm:py-16">
        {session ? (
          <>
            <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-medium tracking-[0.22em] text-stone-500 uppercase">
                  DropVault
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-stone-600">
                    Room{' '}
                    <strong className="font-mono text-base tracking-[0.2em] text-stone-950">
                      {session.code}
                    </strong>
                  </span>
                  <span className="text-xs text-stone-400">({session.role})</span>
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${rtcBadgeColor}`}>
                    {rtcLabel}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleLeave}
                className="self-start rounded-xl border border-stone-300 px-4 py-2 text-sm font-medium text-stone-800 transition-colors hover:border-stone-950 hover:text-stone-950"
              >
                Leave
              </button>
            </header>

            <div className="mt-8 flex flex-1 flex-col gap-8">
              {/* Live QR encodes app URL + active room code for 1-tap mobile scanning */}
              <RoomQrCode roomCode={session.code} />
              <div className="h-px bg-stone-300" role="separator" />

              {/* Real-time shared clipboard with auto-save to MongoDB Atlas */}
              <ShareClip roomCode={session.code} role={session.role} socket={socket} />
              <div className="h-px bg-stone-300" role="separator" />

              {/* Native HTML5 drag-and-drop & click-to-browse file sender */}
              <FileDropZone dataChannel={dataChannel} />

              {/* Incoming file transfer progress indicator */}
              {incomingFile ? (
                <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-stone-900 truncate max-w-[240px]">
                      {incomingFile.name}
                    </span>
                    <span className="text-xs font-mono text-stone-500">
                      {formatBytes(incomingFile.bytes)} / {formatBytes(incomingFile.total)}
                    </span>
                  </div>

                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-100">
                    <div
                      className={`h-full transition-all duration-150 ${incomingFile.done ? 'bg-emerald-600' : 'bg-stone-900'}`}
                      style={{ width: `${incomingFile.percent}%` }}
                    />
                  </div>

                  <div className="mt-2 flex items-center justify-between text-xs text-stone-500">
                    <span>
                      {incomingFile.done
                        ? 'Downloaded to your device'
                        : incomingFile.error
                          ? `Failed: ${incomingFile.error}`
                          : 'Receiving chunked file stream...'}
                    </span>
                    <span className="font-mono font-medium">{incomingFile.percent}%</span>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <header>
              <p className="text-xs font-medium tracking-[0.22em] text-stone-500 uppercase">
                DropVault
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-stone-950 sm:text-5xl">
                Share with a code.
              </h1>
              <p className="mt-3 text-base leading-relaxed text-stone-600">
                Peer-to-peer file transfer and instant clipboard sharing without accounts.
              </p>
            </header>

            <div className="mt-10 flex flex-col gap-8">
              <GeneratePanel code={hostCode} onGenerate={handleGenerate} />
              <div className="h-px bg-stone-300" role="separator" />
              <JoinPanel
                value={joinInput}
                onChange={handleJoinChange}
                onSubmit={handleJoin}
              />
            </div>
          </>
        )}

        {status ? (
          <p
            role="status"
            className={`mt-8 text-sm ${status.tone === 'error' ? 'text-red-700' : 'text-stone-600'}`}
          >
            {status.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}
