/**
 * Frontend RTCDataChannel helper (minimal, from client/dataChannel.js concepts).
 * Keeps channel config consistent for reliable ordered binary file transfer.
 */
export const BUFFER_THRESHOLD_LOW = 1 * 1024 * 1024

export function createReliableDataChannel(peerConnection, channelLabel = 'dropvault-transfer') {
  const dataChannel = peerConnection.createDataChannel(channelLabel, {
    ordered: true,
  })

  dataChannel.binaryType = 'arraybuffer'
  dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD_LOW
  return dataChannel
}
