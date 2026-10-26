import { useQuery } from '@tanstack/react-query'
import { api } from './api.ts'
import type { Me } from '../../shared/types.ts'

/** Who is looking: access level, account name and, for limited accounts, the add limit. */
export function useMe(): Me | undefined {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 30_000 }).data
}

/**
 * True when the account may change the tracker beyond adding players (the "tracker"
 * permission). "trackerUser" accounts only view and add; the server enforces it, this
 * only hides the controls that would answer 403.
 */
export function useFullAccess(): boolean {
  return useMe()?.access === 'full'
}
