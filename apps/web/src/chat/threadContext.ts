import type { Channel, TimelineEvent } from "@vibread/core";
import { createContext, useContext, type ReactNode, type RefObject } from "react";
import type { MissionChatAdapter } from "./missionAdapter.js";

/**
 * What MissionChat's slot components (thread content, composer, tool rows) need; MUI X Chat renders them without props
 * of ours, so they read this context.
 */
export interface ChatThreadValue {
  adapter: MissionChatAdapter;
  events: TimelineEvent[];
  /** A Claude credential exists, so the agent can answer. */
  canChat: boolean;
  hasDesign: boolean;
  /** Channel of the latest revision author (who designed it), for the empty-chat note. */
  designChannel?: Channel;
  /** Shown after the last message and timeline row (mission-complete card). */
  afterMessages?: ReactNode;
  draft: string;
  setDraft(text: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export const ChatThreadContext = createContext<ChatThreadValue | null>(null);

export function useChatThread(): ChatThreadValue {
  const value = useContext(ChatThreadContext);
  if (!value) throw new Error("useChatThread must be used inside MissionChat");
  return value;
}
