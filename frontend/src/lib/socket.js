import { io } from 'socket.io-client'

// Normalize API origin: remove any trailing slashes to prevent malformed URLs
const rawApiOrigin = import.meta.env.VITE_API_URL || ''
const apiOrigin = rawApiOrigin.trim().replace(/\/+$/, '')

export function createSessionSocket() {
  return io(apiOrigin || undefined, {
    transports: ['websocket', 'polling'],
  })
}

export { apiOrigin }
