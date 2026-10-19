import type { FastifyReply } from 'fastify'

type Client = { id: number; reply: FastifyReply }

let nextId = 1
const clients = new Set<Client>()

export function addClient(reply: FastifyReply): number {
  const client: Client = { id: nextId++, reply }
  clients.add(client)
  reply.raw.on('close', () => clients.delete(client))
  return client.id
}

export function broadcast(type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of clients) {
    try {
      client.reply.raw.write(frame)
    } catch {
      clients.delete(client)
    }
  }
}

export function clientCount(): number {
  return clients.size
}
