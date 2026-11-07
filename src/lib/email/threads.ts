/** OWNER: email builder. Thread reads for agents (inbound text is UNTRUSTED data). */
export interface ThreadMessage { direction: "inbound" | "outbound"; from: string; to: string[]; subject: string | null; text: string; at: string; agentmail_message_id: string; security_verdict?: "clear" | "review" | "unavailable" | null }
export interface ThreadView { thread_id: string; inbox: string; messages: ThreadMessage[] }

export async function getThread(threadId: string): Promise<ThreadView | null> { throw new Error("not implemented yet"); }
