import type { ApprovalRequest } from "@vibread/core";
import type { UIMessage } from "ai";
import type { MessageStore } from "../store/messages.js";

/**
 * Chat approvals carry two ids: the AI SDK approval id (in the stream chunk and the stored tool part, covered by the HMAC
 * signature) and the ApprovalBroker request id. The chat id is the public one (UI, POST /api/approvals/:id, MissionDetail);
 * the link is persisted in the assistant message's metadata (`vibread.approvals[approvalId]`) and indexed here.
 */
export interface ApprovalLink {
  approvalId: string;
  brokerId: string;
  missionId: string;
  toolCallId: string;
}

/** Stored in UIMessage.metadata.vibread.approvals[approvalId]; also what the web renders on the approval card. */
export interface ApprovalCardMetadata {
  brokerId: string;
  toolCallId: string;
  summary: string;
  consequence: string;
  actionClass: ApprovalRequest["actionClass"];
  revisionHash: string;
  expiresAt: string;
}

export interface ApprovalLinks {
  record(link: ApprovalLink): void;
  /** Resolves a chat approval id or a broker id. */
  resolve(id: string): ApprovalLink | undefined;
  forBroker(brokerId: string): ApprovalLink | undefined;
  /** Indexes every approval recorded in a mission's stored history (after a restart). */
  hydrate(missionId: string): Promise<UIMessage[]>;
  /** toolCallId → broker id for a history. */
  fromHistory(missionId: string, history: UIMessage[]): ApprovalLink[];
}

export function approvalMetadata(link: { approvalId: string }, request: ApprovalRequest, toolCallId: string): { vibread: { approvals: Record<string, ApprovalCardMetadata> } } {
  return {
    vibread: {
      approvals: {
        [link.approvalId]: {
          brokerId: request.id,
          toolCallId,
          summary: request.summary,
          consequence: request.consequence,
          actionClass: request.actionClass,
          revisionHash: request.revisionHash,
          expiresAt: request.expiresAt,
        },
      },
    },
  };
}

export function createApprovalLinks(deps: { messages: MessageStore }): ApprovalLinks {
  const byChatId = new Map<string, ApprovalLink>();
  const byBrokerId = new Map<string, ApprovalLink>();

  function record(link: ApprovalLink): void {
    byChatId.set(link.approvalId, link);
    byBrokerId.set(link.brokerId, link);
  }

  function fromHistory(missionId: string, history: UIMessage[]): ApprovalLink[] {
    const links: ApprovalLink[] = [];
    for (const message of history) {
      if (message.role !== "assistant") continue;
      const approvals = (message.metadata as { vibread?: { approvals?: Record<string, ApprovalCardMetadata> } } | undefined)?.vibread?.approvals;
      for (const [approvalId, card] of Object.entries(approvals ?? {})) {
        links.push({ approvalId, brokerId: card.brokerId, missionId, toolCallId: card.toolCallId });
      }
    }
    return links;
  }

  return {
    record,
    resolve: (id) => byChatId.get(id) ?? byBrokerId.get(id),
    forBroker: (brokerId) => byBrokerId.get(brokerId),
    fromHistory,
    async hydrate(missionId) {
      const history = await deps.messages.list(missionId);
      for (const link of fromHistory(missionId, history)) record(link);
      return history;
    },
  };
}
