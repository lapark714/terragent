import { inboxes } from "@/lib/agentmail/config";

/** hello@ address (AGENTMAIL_INBOX_HELLO). Server-only: reads env at render time. */
export const helloAddress = () => inboxes().hello.address;
