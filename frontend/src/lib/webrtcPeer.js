import { createReliableDataChannel } from './webrtcChannel'

export const RTC_CONFIGURATION = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
}

export function createPeerConnection({
  socket,
  roomCode,
  onIceCandidate,
  onConnectionStateChange,
  onDataChannel,
}) {
  const peerConnection = new RTCPeerConnection(RTC_CONFIGURATION)

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { roomCode, candidate: event.candidate })
      if (onIceCandidate) onIceCandidate(event.candidate)
    }
  }

  peerConnection.onconnectionstatechange = () => {
    if (onConnectionStateChange) onConnectionStateChange(peerConnection.connectionState)
  }

  // Receiver side: browser fires ondatachannel when remote peer created the channel.
  peerConnection.ondatachannel = (event) => {
    if (onDataChannel) onDataChannel(event.channel)
  }

  return peerConnection
}

export function createSenderDataChannel(peerConnection, label = 'dropvault-transfer') {
  return createReliableDataChannel(peerConnection, label)
}
