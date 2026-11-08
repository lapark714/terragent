/**
 * Tool failures the model can act on. Services throw OutboundError; `guarded()` turns any error
 * into a `{ error }` result (ARCHITECTURE §7) so a bad call never becomes a 500.
 */
import type { ToolRegistrar } from "../mcp/types";

export class OutboundError extends Error {}

export function fail(message: string): never {
  throw new OutboundError(message);
}

export function toolError(name: string, e: unknown): { error: string } {
  if (e instanceof OutboundError) return { error: e.message };
  console.error(`[mcp] ${name} failed`, e);
  return { error: `internal error in ${name}: ${e instanceof Error ? e.message : String(e)}` };
}

/** Wrap a registrar so every handler of a group returns `{ error }` instead of throwing. */
export function guarded(r: ToolRegistrar): ToolRegistrar {
  return {
    tool(name, shape, handler) {
      r.tool(name, shape, async (args, ctx) => {
        try {
          return await handler(args, ctx);
        } catch (e) {
          return toolError(name, e);
        }
      });
    },
  };
}
