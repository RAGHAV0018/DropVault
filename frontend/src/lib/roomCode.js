// Four-digit room codes (0000–9999)
export function generateRoomCode() {
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return String(buffer[0] % 10000).padStart(4, '0')
}

export function isRoomCode(value) {
  return /^\d{4}$/.test(value)
}
