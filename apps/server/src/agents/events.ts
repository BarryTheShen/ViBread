import { EventEmitter } from "node:events";
import type { MissionStore, TimelineEvent } from "@vibread/core";

export interface EventBus {
  /** "*" = every mission. Returns an unsubscribe function. */
  subscribe(missionId: string | "*", listener: (event: TimelineEvent) => void): () => void;
}

/**
 * Per-mission fan-out of the store's timeline feed (MissionService.subscribe). One store subscription; a throwing listener
 * never affects the writer or the other listeners.
 */
export function createEventBus(store: Pick<MissionStore, "subscribe">): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  store.subscribe((event) => {
    emitter.emit(event.missionId, event);
    emitter.emit("*", event);
  });

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
