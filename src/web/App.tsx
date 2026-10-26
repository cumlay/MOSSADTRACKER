import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { api } from './lib/api.ts'
import { useStream } from './lib/useStream.ts'
import { untilText, useNow } from './components/NextFetch.tsx'
import { Ambient } from './components/Ambient.tsx'
import { useMe } from './lib/useAccess.ts'

export default function App() {
  const { connected } = useStream()
  const me = useMe()
  const location = useLocation()
  const now = useNow()
  const [stuck, setStuck] = useState(false)
  const fetching = useIsFetching()
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 20_000 })

  // The nav only grows its backdrop once the page has moved, like on NinjaStats.
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const next = status?.next_fetches?.[0]

  return (
    <div className="min-h-screen">
      <Ambient />

      <div className={`scan ${fetching > 0 ? 'is-on' : ''}`}>
        <i />
      </div>

      <header
        className={`sticky top-0 z-[60] transition-[padding,background,border-color] duration-500 ${
          stuck ? 'border-b border-[var(--line-2)] bg-[rgba(6,7,11,.92)] py-2.5 backdrop-blur-xl' : 'border-b border-transparent py-4'
        }`}
      >
        {/* Wraps rather than overflowing: brand, tabs and status do not fit on a phone. */}
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-5 gap-y-2 px-[clamp(16px,4vw,28px)]">
          <Link to="/" className="flex shrink-0 items-center gap-[11px]">
            <span
              className="grid h-[34px] w-[34px] place-items-center rounded-[11px]"
              style={{ background: 'var(--grad)', boxShadow: '0 8px 24px -10px rgba(124,92,255,.9)' }}
            >
              <svg viewBox="0 0 32 32" aria-hidden className="h-5 w-5" fill="none" stroke="#0a0b10" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 23V9l8 8 8-8v14" />
              </svg>
            </span>
            <span className="text-[15.5px] font-extrabold tracking-[-0.03em]">
              mossad<em className="not-italic text-[var(--txt-3)]">Tracker</em>
            </span>
          </Link>

          <nav className="flex shrink-0 gap-1.5 sm:ml-4">
            <Tab to="/" active={location.pathname === '/' || location.pathname.startsWith('/player')}>
              Snipe
            </Tab>
            <Tab to="/stats" active={location.pathname.startsWith('/stats')}>
              Statistics
            </Tab>
            {me?.access === 'full' && (
              <Tab to="/audit" active={location.pathname.startsWith('/audit')}>
                Audit
              </Tab>
            )}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2.5">
            {next && (
              <span className="pill hidden sm:inline-flex">
                <span className="text-[var(--txt-3)]">next</span>
                <b className="mono text-[13px] font-bold" style={{ color: 'var(--a2)' }}>
                  {untilText(next.due_at, now)}
                </b>
                <span className="text-[var(--txt-3)]">{next.username}</span>
              </span>
            )}

            {status && (
              <span
                className="mono hidden text-[11px] text-[var(--txt-3)] md:block"
                title="Requests spent in the last minute (Hive allows 120/min)"
              >
                {status.global_used_last_minute}/{status.global_limit} req/min
              </span>
            )}

            <span className="pill">
              <span className={`dot ${connected ? 'is-live' : ''}`} style={{ background: connected ? 'var(--ok)' : 'var(--bad)' }} />
              {connected ? 'live' : 'offline'}
            </span>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-[1240px] px-[clamp(16px,4vw,28px)] py-7">
        <Outlet />
      </main>

      <footer className="relative z-10 mx-auto max-w-[1240px] px-[clamp(16px,4vw,28px)] pb-10 pt-2 text-[11.5px] leading-relaxed text-[var(--txt-3)]">
        Public Hive API data · a player is only visible once a match ends, so every detection carries a
        few minutes of uncertainty.
      </footer>
    </div>
  )
}

function Tab({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="relative rounded-full px-3.5 py-2 text-[13.5px] font-semibold transition-colors duration-300"
      style={
        active
          ? { color: 'var(--txt)', background: 'rgba(255,255,255,.07)' }
          : { color: 'var(--txt-2)' }
      }
    >
      {children}
      {active && (
        <span
          className="absolute inset-x-3 -bottom-px h-px"
          style={{ background: 'var(--grad)' }}
        />
      )}
    </Link>
  )
}
