import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import App from './App.tsx'
import Dashboard from './pages/Dashboard.tsx'
import PlayerPage from './pages/PlayerPage.tsx'
import Stats from './pages/Stats.tsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 5_000 } }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
          <Routes>
            <Route element={<App />}>
              <Route index element={<Dashboard />} />
              <Route path="player/:uuid" element={<PlayerPage />} />
              <Route path="stats" element={<Stats />} />
            </Route>
          </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
