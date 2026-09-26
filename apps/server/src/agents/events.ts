import { EventEmitter } from "node:events";
import type { MissionStore, TimelineEvent } from "@vibread/core";

export interface EventBus {
  /** "*" = every mission. Returns an unsubscribe function. */
  subscribe(missionId: string | "*", listener: (event: TimelineEvent) => void): () => void;
}

/**
 * Live timeline for push channels (MissionService.subscribe). The MissionStore contract has no change feed, so the shared
 * store's `appendEvent` is wrapped once: every event any slice appends is published after it is persisted. A throwing
 * listener never affects the writer.
 */
export function createEventBus(store: MissionStore): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const append = store.appendEvent.bind(store);
  store.appendEvent = async (event) => {
    const saved = await append(event);
    emitter.emit(saved.missionId, saved);
    emitter.emit("*", saved);
    return saved;
  };

  return {
    subscribe(missionId, listener) {
      const safe = (event: TimelineEvent) => {
        try {
          listener(event);
        } catch {
          // Listener failures belong to the subscriber (e.g. a closed socket); the timeline write already succeeded.
        }
      };
      emitter.on(missionId, safe);
      return () => emitter.off(missionId, safe);
    },
  };
}
