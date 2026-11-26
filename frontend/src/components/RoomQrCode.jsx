import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

export default function RoomQrCode({ roomCode }) {
  const [copiedLink, setCopiedLink] = useState(false)

  if (!roomCode) return null

  /**
   * Constructs the absolute URL targeting the current application origin, pathname,
   * and room query parameter.
   *
   * Example: "http://localhost:5173/?room=8492" or "https://dropvault.app/?room=8492"
   * `encodeURIComponent` guarantees non-numeric characters are safely URL-escaped.
   */
  const roomUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(
    roomCode
  )}`

  // Copies the full join link to system clipboard for desktop users
  async function handleCopyUrl() {
    try {
      await navigator.clipboard.writeText(roomUrl)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    } catch {
      // Fallback for browsers with restricted clipboard permissions
    }
  }

  return (
    <section className="flex flex-col items-center gap-3.5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      {/* Informative Header */}
      <div className="text-center">
        <h2 className="text-sm font-medium text-stone-900">Scan to join drop</h2>
        <p className="mt-1 text-xs leading-relaxed text-stone-500">
          Point your phone camera at this QR code to join room{' '}
          <span className="font-mono font-semibold tracking-wider text-stone-800">
            {roomCode}
          </span>{' '}
          instantly.
        </p>
      </div>

      {/*
        QRCodeSVG receives dynamic props:
        - `value`: Evaluated dynamically whenever `roomCode` updates.
        - `size`: Desired square viewport dimension in pixels.
        - `level`: Reed-Solomon Error Correction Level ('L'=7%, 'M'=15%, 'Q'=25%, 'H'=30%).
          Level 'M' recovers up to 15% missing or distorted data, ideal for phone cameras.
        - `includeMargin`: Adds standard 4-module quiet zone margin required by ISO spec.
      */}
      <div className="rounded-xl border border-stone-200 bg-white p-2.5 shadow-inner transition-transform hover:scale-[1.02]">
        <QRCodeSVG
          value={roomUrl}
          size={168}
          level="M"
          includeMargin
          aria-label={`QR code for DropVault room ${roomCode}`}
          className="h-auto w-full max-w-[168px]"
        />
      </div>

      {/* Clickable One-Click Copy Link Box */}
      <div className="flex w-full items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2 text-xs">
        <span className="truncate font-mono text-stone-600" title={roomUrl}>
          {roomUrl}
        </span>
        <button
          type="button"
          onClick={handleCopyUrl}
          aria-label="Copy join link to clipboard"
          className="shrink-0 rounded border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-700 shadow-xs transition-colors hover:border-stone-400 hover:text-stone-950"
        >
          {copiedLink ? '✓ Copied' : 'Copy link'}
        </button>
      </div>
    </section>
  )
}
