import { Analytics } from '@vercel/analytics/react'
import HomeScreen from './components/HomeScreen'

export default function App() {
  return (
    <>
      <HomeScreen />
      <Analytics />
    </>
  )
}
