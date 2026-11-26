import { useRef, useState } from 'react'
import { sendFileWithMetadata } from '../lib/fileTransfer'

/**
 * Formats a raw byte count into human-readable binary unit strings (B, KB, MB, GB).
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

/**
 * FileDropZone Component
 *
 * @param {Object} props
 * @param {RTCDataChannel} props.dataChannel - Active WebRTC data channel for P2P streaming.
 * @param {boolean} [props.disabled=false] - Whether file selection/dropping is disabled.
 */
export default function FileDropZone({ dataChannel, disabled = false }) {
  // Visual state when user hovers a file over the drop boundary
  const [isDragActive, setIsDragActive] = useState(false)
  // Transfer progress percentage: clamped integer [0..100]
  const [progress, setProgress] = useState(0)
  // Human-readable status banner
  const [status, setStatus] = useState('Drop a file or click to browse.')
  // Boolean flag indicating whether chunks are actively streaming over SCTP
  const [isSending, setIsSending] = useState(false)
  // Currently selected file descriptor
  const [currentFile, setCurrentFile] = useState(null)

  // Hidden file input for click/touch accessibility on mobile devices
  const fileInputRef = useRef(null)

  function resetProgress() {
    setProgress(0)
  }

  /**
   * HTML5 DragEnter Handler
   */
  function handleDragEnter(event) {
    event.preventDefault()
    event.stopPropagation()
    if (disabled || isSending) return
    setIsDragActive(true)
  }

  /**
   * HTML5 DragOver Handler
   * Mandated by W3C Drag and Drop specification: Calling preventDefault() is what
   * tells the browser that this element is an allowable drop target.
   */
  function handleDragOver(event) {
    event.preventDefault()
    event.stopPropagation()
    if (disabled || isSending) return
    // Signals to the OS window manager to show a "copy" indicator cursor
    event.dataTransfer.dropEffect = 'copy'
    if (!isDragActive) setIsDragActive(true)
  }

  /**
   * HTML5 DragLeave Handler
   */
  function handleDragLeave(event) {
    event.preventDefault()
    event.stopPropagation()
    // Flicker guard: Ignore events fired when transitioning across internal child elements
    if (event.currentTarget.contains(event.relatedTarget)) return
    setIsDragActive(false)
  }

  /**
   * Core WebRTC File Chunking Trigger
   * Slices the File into 64KB ArrayBuffers and streams them across the RTCDataChannel.
   *
   * @param {File} file - W3C File object obtained from DragEvent or FileInput.
   */
  async function processFile(file) {
    if (!file) {
      setStatus('No file detected. Please select or drop a single file.')
      return
    }

    // Guard: Transfer requires an open P2P RTCDataChannel
    if (!dataChannel || dataChannel.readyState !== 'open') {
      setStatus('WebRTC data channel is not ready. Connect peers in the same room to open the P2P pipe.')
      resetProgress()
      return
    }

    setIsSending(true)
    setCurrentFile({
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
    })
    setStatus(`Preparing "${file.name}" (${formatBytes(file.size)}) for transfer...`)
    resetProgress()

    try {
      /**
       * Calls DropVault's WebRTC chunking protocol:
       * 1. Sends metadata JSON packet `{ type: 'file-meta', name, size, totalChunks }`
       * 2. Slices file into 64KB ArrayBuffers via `file.slice(offset, offset + CHUNK_SIZE)`
       * 3. Sends each chunk over SCTP while honoring backpressure flow control
       * 4. Dispatches progress callback: (percent, bytesSent, totalBytes)
       */
      await sendFileWithMetadata(dataChannel, file, (percent, bytesSent, totalBytes) => {
        /**
         * ---------------------------------------------------------------------
         * PROGRESS CALCULATION MATH:
         * ---------------------------------------------------------------------
         * Fraction complete = bytesSent / totalBytes
         * Percentage = (bytesSent / totalBytes) * 100
         *
         * Edge-case guards:
         * - If totalBytes is 0 (empty file), avoid division by zero (NaN).
         * - Math.max(0, ...) ensures no negative values.
         * - Math.min(100, ...) guarantees progress never exceeds 100%.
         * - Math.round(...) normalizes to integer for smooth CSS bar animation.
         */
        const computedPercent =
          totalBytes > 0 ? Math.round((bytesSent / totalBytes) * 100) : 100
        const safePercent = Math.min(
          100,
          Math.max(0, Number.isFinite(percent) ? Math.round(percent) : computedPercent)
        )

        setProgress(safePercent)
        setStatus(
          `Sending "${file.name}" — ${safePercent}% (${formatBytes(bytesSent)} / ${formatBytes(totalBytes)})`
        )
      })

      setProgress(100)
      setStatus(`Transfer complete: "${file.name}" (${formatBytes(file.size)}) sent successfully.`)
    } catch (error) {
      console.error('[DropVault:DropZone] Transfer failed:', error)
      setStatus(error?.message || 'File transfer failed.')
    } finally {
      setIsSending(false)
      // Reset file input value so re-selecting the identical file triggers onChange
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  /**
   * HTML5 Drop Handler
   * Intercepts the dropped file, suppresses default browser navigation,
   * and triggers WebRTC chunked streaming.
   */
  async function handleDrop(event) {
    // MANDATORY: Stops browser from navigating to the dropped file's local URL
    event.preventDefault()
    event.stopPropagation()
    setIsDragActive(false)

    if (disabled || isSending) return

    // Extract first dropped file from the DataTransfer item list
    const file = event.dataTransfer?.files?.[0]
    await processFile(file)
  }

  /**
   * Click-to-Browse File Picker Handler
   * Provides full touch and mobile device compatibility where drag-and-drop is unavailable.
   */
  function handleFileInputChange(event) {
    const file = event.target?.files?.[0]
    if (file) {
      processFile(file)
    }
  }

  function handleZoneClick() {
    if (disabled || isSending) return
    fileInputRef.current?.click()
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleZoneClick()
    }
  }

  const isReady = Boolean(dataChannel && dataChannel.readyState === 'open') && !disabled

  const dropZoneClassName = [
    'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-all cursor-pointer outline-none select-none',
    isDragActive
      ? 'border-stone-950 bg-stone-100 scale-[1.01]'
      : 'border-stone-300 bg-white hover:border-stone-500',
    !isReady || isSending ? 'opacity-75 cursor-not-allowed' : '',
  ].join(' ')

  return (
    <section className="flex flex-col gap-3">
      {/* Hidden file input supporting mobile/click file picking */}
      <input
        ref={fileInputRef}
        type="file"
        aria-hidden="true"
        className="hidden"
        onChange={handleFileInputChange}
        disabled={!isReady || isSending}
      />

      <div>
        <h2 className="text-sm font-medium text-stone-900">Send a file</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Drag and drop any file (PDF, image, video, code) or click to browse.
        </p>
      </div>

      {/* HTML5 Drag-and-Drop Zone */}
      <div
        role="button"
        tabIndex={isReady && !isSending ? 0 : -1}
        aria-label="File drop zone"
        aria-disabled={!isReady || isSending}
        onClick={handleZoneClick}
        onKeyDown={handleKeyDown}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={dropZoneClassName}
      >
        <svg
          className={`h-10 w-10 transition-colors ${isDragActive ? 'text-stone-950' : 'text-stone-400'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>

        <p className="mt-3 text-sm font-medium text-stone-800">
          {isDragActive
            ? 'Release to drop the file'
            : isSending
              ? `Sending ${currentFile?.name || 'file'}...`
              : 'Drag & drop a file here, or click to browse'}
        </p>

        <p className="mt-1 text-xs text-stone-500">
          {isReady
            ? 'P2P Data Channel Ready · Direct encrypted transfer'
            : 'Waiting for peer to connect before sending'}
        </p>
      </div>

      {/* Dynamic Accessible Progress Bar */}
      <div className="flex flex-col gap-1.5">
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-stone-200"
          role="progressbar"
          aria-label="File transfer progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className={`h-full transition-[width] duration-150 ease-out ${
              progress === 100 ? 'bg-emerald-600' : 'bg-stone-950'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-stone-500">
          <span className="truncate max-w-[240px]">
            {currentFile ? `${currentFile.name} (${formatBytes(currentFile.size)})` : 'No file selected'}
          </span>
          <span className="font-mono font-medium">{progress}%</span>
        </div>
      </div>

      {/* Screen-reader and Live Visual Status Text */}
      <p className="text-sm text-stone-600" role="status">
        {status}
      </p>
    </section>
  )
}
