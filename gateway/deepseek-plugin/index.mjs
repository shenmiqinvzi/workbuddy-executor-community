import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createAdapter, logicalIdentity } from './adapter.mjs';
import { startTransport } from './transport.mjs';

export const name = 'codex-deepseek-bridge';
export const inject = ['sessionController', 'agents', 'pluginPackages', 'profileContext'];
export async function apply(ctx, config = {}) {
  const identity = await logicalIdentity(ctx);
  const root = config.root ?? join(homedir(), '.dsh', 'codex-bridge');
  if (!isAbsolute(root)) throw new Error('Bridge storage requires an absolute private directory');
  const adapter = await createAdapter(ctx, { root, ...identity });
  const transport = await startTransport({ root, ...identity, invoke: adapter.invoke });
  ctx.effect(() => () => transport.close(), 'codex-deepseek-bridge: private local transport');
  ctx.logger?.info?.(`Codex bridge ready for ${identity.identity.profile} Host ${identity.hostId}`);
}
