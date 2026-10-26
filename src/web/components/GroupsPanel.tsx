import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import type { Group } from '../../shared/types.ts'

const input =
  'glass-well min-w-0 px-3 py-1.5 text-[12.5px] outline-none transition-colors placeholder:text-[var(--txt-3)] focus:border-[color-mix(in_oklab,var(--a1),transparent_55%)]'

const PALETTE = ['#7c5cff', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#ff8a3d', '#4aa3ff']

/**
 * Create, rename and delete groups, and pick the Discord channel each one's alerts go
 * to. Players are put in a group from their own page.
 */
export function GroupsPanel() {
  const qc = useQueryClient()
  const { data: groups } = useQuery({ queryKey: ['groups'], queryFn: api.groups })
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const done = () => {
    setEditing(null)
    setError(null)
    void qc.invalidateQueries({ queryKey: ['groups'] })
    void qc.invalidateQueries({ queryKey: ['players'] })
  }
  const onError = (e: Error) => setError(e.message)
  const create = useMutation({ mutationFn: api.createGroup, onSuccess: done, onError })
  const update = useMutation({ mutationFn: ({ id, ...g }: Group) => api.updateGroup(id, g), onSuccess: done, onError })
  const remove = useMutation({ mutationFn: api.deleteGroup, onSuccess: done, onError })

  return (
    <div className="glass card-pad p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="label">Groups</div>
        {editing === null && (
          <button className="text-[11.5px] font-semibold text-[var(--a2)]" onClick={() => setEditing('new')}>
            + new group
          </button>
        )}
      </div>

      {groups?.length === 0 && editing === null && (
        <p className="text-[11.5px] leading-relaxed text-[var(--txt-3)]">
          Organise the watchlist into clans or friend groups. Each group can post its alerts in its own Discord channel.
        </p>
      )}

      <div className="space-y-1.5">
        {groups?.map((g) =>
          editing === g.id ? (
            <GroupForm
              key={g.id}
              initial={g}
              busy={update.isPending}
              onSave={(next) => update.mutate({ ...g, ...next })}
              onCancel={() => setEditing(null)}
              onDelete={() => remove.mutate(g.id)}
            />
          ) : (
            <button
              key={g.id}
              onClick={() => setEditing(g.id)}
              className="flex w-full items-center gap-2 rounded-[10px] px-2 py-1 text-left text-[12.5px] transition-colors hover:bg-white/[0.05]"
            >
              <i className="h-2.5 w-2.5 rounded-full" style={{ background: g.color }} />
              <span className="font-semibold">{g.name}</span>
              <span className="ml-auto text-[10.5px] text-[var(--txt-3)]">{g.channel_id ? 'own channel' : 'default channel'}</span>
            </button>
          )
        )}
        {editing === 'new' && (
          <GroupForm
            initial={{ name: '', color: PALETTE[(groups?.length ?? 0) % PALETTE.length]!, channel_id: null }}
            busy={create.isPending}
            onSave={(g) => create.mutate(g)}
            onCancel={() => setEditing(null)}
          />
        )}
      </div>

      {error && <p className="mt-2 text-[11.5px]" style={{ color: 'var(--bad)' }}>{error}</p>}
    </div>
  )
}

function GroupForm({
  initial,
  busy,
  onSave,
  onCancel,
  onDelete
}: {
  initial: Omit<Group, 'id'>
  busy: boolean
  onSave: (g: Omit<Group, 'id'>) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [color, setColor] = useState(initial.color)
  const [channel, setChannel] = useState(initial.channel_id ?? '')

  return (
    <div className="glass-well space-y-2 p-3" style={{ borderRadius: 14 }}>
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Group name" className={`${input} w-full`} autoFocus />
      <div className="flex flex-wrap gap-1.5">
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            aria-label={c}
            className="h-5 w-5 rounded-full transition-transform"
            style={{ background: c, outline: color === c ? '2px solid var(--txt)' : 'none', outlineOffset: 2 }}
          />
        ))}
      </div>
      <input
        value={channel}
        onChange={(e) => setChannel(e.target.value.replace(/\D/g, ''))}
        placeholder="Discord channel ID (optional)"
        className={`${input} mono w-full`}
      />
      <div className="flex gap-2">
        <button className="btn" disabled={!name.trim() || busy} onClick={() => onSave({ name: name.trim(), color, channel_id: channel || null })}>
          Save
        </button>
        <button className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button className="ml-auto text-[11.5px] text-[var(--txt-3)] transition-colors hover:text-[var(--bad)]" onClick={onDelete}>
            delete
          </button>
        )}
      </div>
    </div>
  )
}
