/**
 * Dev entry point for the API.
 *
 * `npm run dev` runs Vite and the API side by side, and some harnesses inject a
 * PORT env var meant for the *web* server — pinning API_PORT here keeps the two
 * from fighting over the same port.
 */
process.env.API_PORT ??= '3717'
await import('../src/server/index.ts')
