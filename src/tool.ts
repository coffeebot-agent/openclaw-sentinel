import { z } from 'zod';
import { WatcherManager } from './watcherManager.js';

const inputSchema = z.object({
  action: z.enum(['create', 'enable', 'disable', 'remove', 'status', 'list']),
  id: z.string().optional(),
  watcher: z.unknown().optional()
}).strict();

export function registerSentinelControl(registerTool: (name: string, handler: (input: unknown) => Promise<unknown>) => void, manager: WatcherManager): void {
  registerTool('sentinel_control', async (input) => {
    const parsed = inputSchema.parse(input);
    switch (parsed.action) {
      case 'create': return manager.create(parsed.watcher);
      case 'enable': if (!parsed.id) throw new Error('id required'); await manager.enable(parsed.id); return { ok: true };
      case 'disable': if (!parsed.id) throw new Error('id required'); await manager.disable(parsed.id); return { ok: true };
      case 'remove': if (!parsed.id) throw new Error('id required'); await manager.remove(parsed.id); return { ok: true };
      case 'status': if (!parsed.id) throw new Error('id required'); return manager.status(parsed.id);
      case 'list': return manager.list();
    }
  });
}
