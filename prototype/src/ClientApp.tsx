'use client'
import dynamic from 'next/dynamic'

/** The prototype keeps all state in the browser and runs on a demo clock, so it renders client-side only. */
const App = dynamic(() => import('./App'), { ssr: false, loading: () => <div className="login muted">Loading prototype…</div> })
export default function ClientApp() {
  return <App />
}
