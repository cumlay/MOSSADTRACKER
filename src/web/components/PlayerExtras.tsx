import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { ago, dateTime } from '../lib/format.ts'
import { typicalText } from '../../shared/insights.ts'
import { game } from '../../shared/games.ts'
import type { Group, Note, PlayedWith, PlayerRow, Typical } from '../../shared/types.ts'
import { GameBadge } from './StatusPill.tsx'

const input =
  'glass-well min-w-0 px-3 py-1.5 text-[12.5px] outline-none transition-colors placeholder:text-[var(--txt-3)] focus:border-[color-mix(in_oklab,var(--a1),transparent_55%)]'

/** Small coloured pill for a tag or a group. */
export function TagChip({ label, color = '#a2aabd', onRemove }: { label: string; color?: string; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[11px] font-semibold"
      style={{ color, background: `color-mix(in oklab, ${color}, transparent 88%)`, border: `1px solid color-mix(in oklab, ${color}, transparent 72%)` }}
    >
      {label}
      {onRemove && (
        <button onClick={onRemove} className="opacity-60 transition-opacity hover:opacity-100" aria-label={`remove ${label}`}>
          ×
        </button>
      )}
    </span>
  )
}

export function GroupChip({ group }: { group: Pick<Group, 'name' | 'color'> }) {
  return <TagChip label={group.name} color={group.color} />
}

/* ---------------------------------------------------------- tags + group */

/** Tags and group of one player; editable with full access, read-only otherwise. */
export function Organise({ player, editable }: { player: PlayerRow; editable: boolean }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { data: groups } = useQuery({ queryKey: ['groups'], queryFn: api.groups, enabled: editable })

  const done = () => {
    setError(null)
    void qc.invalidateQueries({ queryKey: ['player', player.uuid] })
    void qc.invalidateQueries({ queryKey: ['players'] })
  }
  const tags = useMutation({ mutationFn: (next: string[]) => api.setTags(player.uuid, next), onSuccess: done, onError: (e: Error) => setError(e.message) })
  const group = useMutation({ mutationFn: (id: number | null) => api.setGroup(player.uuid, id), onSuccess: done, onError: (e: Error) => setError(e.message) })

  const addTag = () => {
    const t = draft.trim()
    if (!t) return
    tags.mutate([...player.tags, t])
    setDraft('')
  }

  if (!editable && player.tags.length === 0 && !player.group) return null

  return (
    <section className="glass card-pad p-5">
      <div className="label mb-3">Tags & group</div>

      <div className="flex flex-wrap items-center gap-1.5">
        {player.tags.map((t) => (
          <TagChip key={t} label={t} onRemove={editable ? () => tags.mutate(player.tags.filter((x) => x !== t)) : undefined} />
        ))}
        {player.tags.length === 0 && <span className="text-[11.5px] text-[var(--txt-3)]">No tags.</span>}
      </div>

      {editable && (
        <div className="mt-2 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTag()}
            maxLength={24}
            placeholder="add a tag: main, alt, cheater?…"
            className={`${input} flex-1`}
          />
          <button className="btn btn--ghost" disabled={!draft.trim() || tags.isPending} onClick={addTag}>
            Add
          </button>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 text-[12.5px]">
        <span className="text-[var(--txt-3)]">Group</span>
        {editable ? (
          <select
            value={player.group?.id ?? ''}
            onChange={(e) => group.mutate(e.target.value === '' ? null : Number(e.target.value))}
            className={`${input} flex-1`}
          >
            <option value="">— none —</option>
            {groups?.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        ) : player.group ? (
          <GroupChip group={player.group} />
        ) : (
          <span className="text-[var(--txt-3)]">none</span>
        )}
      </div>

      {error && <p className="mt-2 text-[11.5px]" style={{ color: 'var(--bad)' }}>{error}</p>}
    </section>
  )
}

/* ------------------------------------------------------------------ notes */

export function Notes({ uuid, notes, editable }: { uuid: string; notes: Note[]; editable: boolean }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['player', uuid] })
  const add = useMutation({ mutationFn: (body: string) => api.addNote(uuid, body), onSuccess: () => (setDraft(''), refresh()) })
  const remove = useMutation({ mutationFn: (id: number) => api.deleteNote(uuid, id), onSuccess: refresh })

  if (!editable && notes.length === 0) return null

  return (
    <section className="glass card-pad p-5">
      <div className="label mb-3">Notes</div>

      {editable && (
        <div className="mb-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Anything worth remembering about this player…"
            className={`${input} w-full resize-y`}
          />
          <div className="mt-1.5 flex justify-end">
            <button className="btn" disabled={!draft.trim() || add.isPending} onClick={() => add.mutate(draft.trim())}>
              Save note
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2.5">
        {notes.map((n) => (
          <div key={n.id} className="border-t border-[var(--line-2)] pt-2 first:border-0 first:pt-0">
            <p className="whitespace-pre-wrap break-words text-[12.5px] text-[var(--txt-2)]">{n.body}</p>
            <div className="mt-1 flex items-center gap-2 text-[10.5px] text-[var(--txt-3)]">
              <span>
                {n.author} · {dateTime(n.created_at)}
              </span>
              {editable && (
                <button className="ml-auto transition-colors hover:text-[var(--bad)]" onClick={() => remove.mutate(n.id)}>
                  delete
                </button>
              )}
            </div>
          </div>
        ))}
        {notes.length === 0 && <p className="text-[11.5px] text-[var(--txt-3)]">No notes yet.</p>}
      </div>
    </section>
  )
}

/* --------------------------------------------------------------- insights */

export function Insights({ typical, mates }: { typical: Typical | null; mates: PlayedWith[] }) {
  return (
    <section className="glass card-pad p-5">
      <div className="label mb-2">Usually online</div>
      <p className="text-[13px] text-[var(--txt-2)]">
        {typical ? (
          <>
            {typicalText(typical)}
            <span className="text-[var(--txt-3)]"> · {typical.timezone}</span>
          </>
        ) : (
          <span className="text-[var(--txt-3)]">Not enough play recorded yet — needs about 90 minutes over the last 60 days.</span>
        )}
      </p>

      <div className="label mb-2 mt-4">Often plays with</div>
      {mates.length === 0 && <p className="text-[11.5px] text-[var(--txt-3)]">Nobody on the watchlist so far.</p>}
      <div className="space-y-1.5">
        {mates.map((m) => (
          <div key={m.uuid} className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <Link to={`/player/${m.uuid}`} className="font-semibold hover:underline">
              {m.username}
            </Link>
            <span className="text-[var(--txt-3)]">
              {m.sessions} {m.sessions === 1 ? 'session' : 'sessions'} · last {ago(m.last_at)}
            </span>
            <span className="flex gap-1">
              {m.games.map((g) => (
                <GameBadge key={g} id={g} color={game(g).color} label={game(g).short} />
              ))}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--txt-3)]">
        Sessions that overlapped on the same game. Detections are minutes wide, so this means “probably together”, not
        “same match”.
      </p>
    </section>
  )
}
