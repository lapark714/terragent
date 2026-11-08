/**
 * Built-in tool presets. Every agent runs with `default_config: deny`, so a tool is offered only if it
 * is listed here as allow. The NEVER list is also written out explicitly as deny, so a later change
 * of default can't silently hand an agent email, money or phone tools.
 */
import type { BrowserOptionsInput } from "@usenaive-sdk/managed-agents";
import type { ToolConfigs, ToolSetting } from "./types";

export const allow = (config?: Record<string, unknown>): ToolSetting => ({ enabled: true, permission: "allow", ...(config ? { config } : {}) });
export const deny: ToolSetting = { enabled: false, permission: "deny" };

/**
 * Never offered to any agent: all mail goes through our gated MCP tools (and reading mail would flag
 * the chat as "read people's data"), no social posts, no money, no phones, no generated imagery
 * (it would look fabricated next to satellite data), no blocking questions to an operator.
 */
export const NEVER = [
  "email.send",
  "email.read",
  "social.post",
  "phone.send",
  "wallet.pay",
  "wallet.transfer",
  "card.issue",
  "card.credentials",
  "mobile",
  "generate_image",
  "generate_video",
  "ask_operator",
] as const;

export const neverTools = (): ToolConfigs => Object.fromEntries(NEVER.map((t) => [t, deny]));

/** Team members may read their card; only terragent.handoff / set_status move it (no double writes). */
export const MEMBER: ToolConfigs = { board_read: allow(), board_write: deny, session_spend: allow() };

export const SKILL_READER: ToolConfigs = { read_skill: allow() };

export const WEB: ToolConfigs = { web_search: allow(), web_fetch: allow({ max_content_tokens: 4000 }) };

/** Naïve's data catalogue. data_run asks by default, which would park every cron run. */
export const DATA: ToolConfigs = { data_search: allow(), data_describe: allow(), data_run: allow() };

export const VISION: ToolConfigs = { view_image: allow() };

/** The agent's own computer: run the pipeline, move files between disk and Naïve Files. */
export const COMPUTER: ToolConfigs = {
  bash: allow(),
  read: allow(),
  write: allow(),
  edit: allow(),
  ls: allow(),
  find: allow(),
  fetch_file: allow(),
  publish_file: allow(),
};

/** Browser actions that can fill in or submit a form; everything else (goto, observe, extract, links, screenshot) only reads. */
export const BROWSER_WRITE_ACTIONS = ["act", "click", "type"] as const;

/**
 * Contact-form outreach (NOTES "Outbound channel"): never solve CAPTCHAs, no stealth, and signing up or
 * logging in anywhere pauses for a human. A contact form is an outbound send, so until a founder sets
 * OUTREACH_CONTACT_FORM_APPROVED (and re-provisions) every write-capable action also pauses for a
 * founder: Naïve enforces it, whatever the prompt, the template state or a hostile page says.
 */
export function outreachBrowserOptions(contactFormsApproved: boolean) {
  return {
    solve_captchas: false,
    stealth: false,
    allow_writes: true,
    block_ads: true,
    timeout_minutes: 10,
    ask_actions: ["signup", "login", ...(contactFormsApproved ? [] : BROWSER_WRITE_ACTIONS)],
  } satisfies BrowserOptionsInput;
}

export const browserTools = (o: { contactFormsApproved: boolean }): ToolConfigs => ({ browser: allow(outreachBrowserOptions(o.contactFormsApproved)) });

/** Board owner: reads and writes cards, can see and message its roster. */
export const COORDINATOR_TEAM: ToolConfigs = {
  board_read: allow(),
  board_write: allow(),
  list_agents: allow(),
  send_to_agent: allow(),
  wait_for_agents: allow(),
  session_spend: allow(),
};
