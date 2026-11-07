import { customAlphabet } from "nanoid";

// Lowercase, no look-alike characters: readable in email subjects and logs.
const gen = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 10);

export const ID_PREFIX = {
  request: "req",
  report: "rpt",
  quote: "qte",
  order: "ord",
  decision: "dec",
  signal: "sig",
  prospect: "pro",
  template: "tpl",
  message: "msg",
  monitor: "mon",
  apiKey: "key",
  marketPrice: "mkt",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${gen()}`;
}

/** Unguessable token for public report URLs. */
export const newToken = customAlphabet("23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ", 24);
