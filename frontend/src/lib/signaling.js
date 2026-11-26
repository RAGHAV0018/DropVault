// WebRTC signaling helpers for SDP offer/answer exchange and ICE candidates

export async function createAndSendOffer(peerConnection, socket, roomCode) {
  if (!peerConnection) {
    throw new Error('[WebRTC] PeerConnection is not initialized.')
  }
  if (!socket || !roomCode) {
    throw new Error('[WebRTC] Socket or roomCode missing for signaling.')
  }

  const offer = await peerConnection.createOffer()
  await peerConnection.setLocalDescription(offer)

  socket.emit('webrtc-offer', {
    roomCode,
    offer: {
      type: offer.type,
      sdp: offer.sdp,
    },
  })

  return offer
}

export async function receiveOfferAndSendAnswer(peerConnection, socket, roomCode, offer) {
  if (!peerConnection) {
    throw new Error('[WebRTC] PeerConnection is not initialized.')
  }

  // Guard: An offer can only be set when in 'stable' state (or after polite rollback)
  if (peerConnection.signalingState !== 'stable') {
    console.warn(`[WebRTC] Cannot process SDP offer in signalingState '${peerConnection.signalingState}'.`)
    return
  }

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
  const answer = await peerConnection.createAnswer()
  await peerConnection.setLocalDescription(answer)

  socket.emit('webrtc-answer', {
    roomCode,
    answer: {
      type: answer.type,
      sdp: answer.sdp,
    },
  })

  return answer
}

export async function receiveAnswer(peerConnection, answer) {
  if (!peerConnection) {
    throw new Error('[WebRTC] PeerConnection is not initialized.')
  }

  // Guard: An answer is only valid when expecting one ('have-local-offer').
  // If already 'stable', the answer was already accepted or duplicate.
  if (peerConnection.signalingState !== 'have-local-offer') {
    console.log(`[WebRTC] Skipping duplicate or late SDP answer in '${peerConnection.signalingState}'.`)
    return
  }

  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
}

export async function addRemoteIceCandidate(peerConnection, candidate) {
  if (!peerConnection || !candidate) return
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
  } catch (error) {
    console.error('[WebRTC] Failed to add remote ICE candidate:', error)
  }
}
