import type { ChannelAdapter, ChannelId } from "./types.js";

const CHANNEL_ID_RE = /^[a-z][a-z0-9-]*$/;

export class ChannelRegistry {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    if (!CHANNEL_ID_RE.test(adapter.id)) {
      throw new Error(`invalid channel id: ${adapter.id}`);
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`duplicate channel adapter: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: ChannelId): ChannelAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`channel adapter not found: ${id}`);
    }
    return adapter;
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}
