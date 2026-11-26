// Optimal chunk size for RTCDataChannel: 64 KB
export const CHUNK_SIZE = 64 * 1024;

// Backpressure flow control limits (in bytes)
export const BUFFER_HIGH_WATERMARK = 16 * 1024 * 1024; // 16 MB
export const BUFFER_LOW_WATERMARK = 1 * 1024 * 1024;   // 1 MB

/**
 * =============================================================================
 * SENDER: TRANSMIT FILE METADATA AND CHUNKS ACROSS RTCDATACHANNEL
 * =============================================================================
 *
 * Protocol Sequence:
 *   1. Send JSON header: `{ type: "file-meta", name, size, mimeType, ... }`
 *   2. Stream binary ArrayBuffer chunks (64 KB each) with flow control
 *   3. Send JSON completion: `{ type: "file-complete", fileId }`
 *
 * @param {RTCDataChannel} dataChannel - Open RTCDataChannel instance.
 * @param {File} file - Browser File object (from <input type="file"> or drag-and-drop).
 * @param {Function} [onProgress] - Callback: (percent, bytesSent, totalBytes) => void.
 * @returns {Promise<{ fileId: string, name: string, size: number }>}
 */
export async function sendFileWithMetadata(dataChannel, file, onProgress) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    throw new Error("[DropVault] Cannot send file: RTCDataChannel is not open.");
  }

  if (!file) {
    throw new Error("[DropVault] No file provided for transfer.");
  }

  // 1. Generate Unique File Identifier & Calculate Chunks
  const fileId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `file-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // 2. Prepare Structured File Metadata Header
  const metadata = {
    type: "file-meta",
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    lastModified: file.lastModified || Date.now(),
    chunkSize: CHUNK_SIZE,
    totalChunks,
    timestamp: Date.now(),
  };

  console.log(`[FileTransfer:Sender] Transmitting metadata for '${file.name}' (${file.size} bytes)...`);

  // 3. Send Metadata Header Packet across the DataChannel as a JSON string
  dataChannel.send(JSON.stringify(metadata));

  // 4. Stream File Chunks with Flow Control (Backpressure)
  let offset = 0;
  let chunkIndex = 0;

  // Set low-watermark threshold for buffer drainage notification
  dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;

  while (offset < file.size) {
    // FLOW CONTROL: If the dataChannel buffer is filled, pause sending
    // until the underlying SCTP stack pushes data out over the network
    if (dataChannel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
      await new Promise((resolve) => {
        dataChannel.onbufferedamountlow = () => {
          dataChannel.onbufferedamountlow = null; // Remove listener
          resolve();
        };
      });
    }

    // Slice the file into a 64 KB Blob, then read as binary ArrayBuffer
    const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
    const arrayBuffer = await chunkBlob.arrayBuffer();

    // Send binary chunk directly over SCTP
    dataChannel.send(arrayBuffer);

    offset += arrayBuffer.byteLength;
    chunkIndex++;

    // Report progress
    if (onProgress) {
      const percent = Math.min(100, Math.round((offset / file.size) * 100));
      onProgress(percent, offset, file.size);
    }
  }

  // 5. Send Completion Signal
  const completionSignal = {
    type: "file-complete",
    fileId,
    name: file.name,
    totalBytesSent: offset,
    chunksSent: chunkIndex,
    timestamp: Date.now(),
  };
  dataChannel.send(JSON.stringify(completionSignal));

  console.log(`✅ [FileTransfer:Sender] Transfer complete for '${file.name}'. All ${chunkIndex} chunks sent.`);

  return { fileId, name: file.name, size: file.size };
}

/**
 * =============================================================================
 * RECEIVER: ACCUMULATOR THAT PROCESSES METADATA & REASSEMBLES CHUNKS
 * =============================================================================
 *
 * Factory function that returns a message handler for `dataChannel.onmessage`.
 * It automatically inspects message types:
 *   - Strings -> Parses JSON control messages (metadata & completion)
 *   - ArrayBuffers -> Accumulates binary file chunks
 *
 * @param {Object} callbacks
 * @param {Function} [callbacks.onMetadataReceived] - (metadata) => void
 * @param {Function} [callbacks.onProgress] - (percent, receivedBytes, totalBytes) => void
 * @param {Function} [callbacks.onFileComplete] - ({ blob, metadata, downloadUrl, fileName }) => void
 * @param {Function} [callbacks.onError] - (error) => void
 * @returns {Function} Message handler to pass to `dataChannel.onmessage`
 */
export function createFileReceiver({
  onMetadataReceived,
  onProgress,
  onFileComplete,
  onError,
} = {}) {
  // State for the incoming file transfer
  let currentMeta = null;
  let receivedChunks = [];
  let receivedBytes = 0;

  return function handleIncomingMessage(event) {
    const data = event.data;

    // -------------------------------------------------------------------------
    // CASE A: INCOMING STRING (JSON Control Packet: Metadata or Completion)
    // -------------------------------------------------------------------------
    if (typeof data === "string") {
      try {
        const message = JSON.parse(data);

        // 1. FILE METADATA PACKET
        if (message.type === "file-meta") {
          currentMeta = message;
          receivedChunks = [];
          receivedBytes = 0;

          console.log(
            `📦 [FileTransfer:Receiver] Metadata received for '${message.name}' (${message.size} bytes, ${message.mimeType})`
          );

          if (onMetadataReceived) {
            onMetadataReceived(currentMeta);
          }
          return;
        }

        // 2. FILE COMPLETION PACKET
        if (message.type === "file-complete") {
          console.log(
            `🎉 [FileTransfer:Receiver] Completion signal received for '${message.name}' (${receivedBytes} bytes)`
          );

          if (!currentMeta) {
            console.warn("[FileTransfer:Receiver] Received file-complete without active metadata.");
            return;
          }

          // Validate integrity: Check if received bytes match declared size
          if (receivedBytes !== currentMeta.size) {
            console.error(
              `❌ [FileTransfer:Receiver] Integrity mismatch! Expected: ${currentMeta.size} bytes, Received: ${receivedBytes} bytes`
            );
            if (onError) {
              onError(new Error("File integrity check failed: partial or corrupted transfer."));
            }
            return;
          }

          // Reassemble all binary ArrayBuffer chunks into a single Blob
          const fileBlob = new Blob(receivedChunks, {
            type: currentMeta.mimeType || "application/octet-stream",
          });

          // Create browser download object URL
          const downloadUrl = URL.createObjectURL(fileBlob);

          if (onFileComplete) {
            onFileComplete({
              blob: fileBlob,
              metadata: currentMeta,
              downloadUrl,
              fileName: currentMeta.name,
              size: currentMeta.size,
              mimeType: currentMeta.mimeType,
            });
          }

          // Reset accumulator for next file
          currentMeta = null;
          receivedChunks = [];
          receivedBytes = 0;
          return;
        }
      } catch {
        // Plain text message (e.g. clipboard text) rather than JSON
        console.log("[FileTransfer:Receiver] Received non-JSON string message:", data);
      }
      return;
    }

    // -------------------------------------------------------------------------
    // CASE B: INCOMING BINARY CHUNK (ArrayBuffer, Blob, or TypedArray)
    // -------------------------------------------------------------------------
    // Defensive handling: Chromium/WebKit/Gecko default RTCDataChannel.binaryType
    // to "blob" unless explicitly configured as "arraybuffer".
    // Supporting ArrayBuffer, Blob, and TypedArray ensures zero dropped chunks
    // regardless of browser quirks or runtime transport differences.
    const isBlob = typeof Blob !== "undefined" && data instanceof Blob;
    const isArrayBuffer = data instanceof ArrayBuffer;
    const isView = ArrayBuffer.isView(data);

    if (isArrayBuffer || isBlob || isView) {
      if (!currentMeta) {
        console.warn("[FileTransfer:Receiver] Received binary chunk without prior file metadata. Dropping chunk.");
        return;
      }

      // Track byte progress safely across ArrayBuffer (.byteLength) and Blob (.size)
      const byteLength = isBlob ? data.size : data.byteLength;
      receivedChunks.push(data);
      receivedBytes += byteLength;

      // Report progress percentage
      if (onProgress) {
        const percent = Math.min(100, Math.round((receivedBytes / currentMeta.size) * 100));
        onProgress(percent, receivedBytes, currentMeta.size);
      }

      // Check if file is fully received based on total size
      if (receivedBytes >= currentMeta.size) {
        console.log(`[FileTransfer:Receiver] Reached 100% of bytes for '${currentMeta.name}'.`);
      }
    }
  };
}

/**
 * Helper to trigger an immediate browser download of an assembled file.
 *
 * @param {string} downloadUrl - Object URL generated from Blob.
 * @param {string} fileName - Destination file name.
 */
export function triggerFileDownload(downloadUrl, fileName) {
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();

  // Clean up DOM node and release Object URL after delay
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(downloadUrl);
  }, 1000);
}
