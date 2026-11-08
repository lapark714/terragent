import type { Playbook } from "@/lib/domain";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../palette";

/** Playbook key: a colour swatch beside plain text (identity never relies on colour alone). */
export function PlaybookLegend({ playbooks = ["disasters", "deforestation", "mining", "inbound"] }: { playbooks?: Playbook[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Playbooks">
      {playbooks.map((p) => (
        <li key={p} className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${PLAYBOOK_BG[p]}`} aria-hidden />
          {PLAYBOOK_LABEL[p]}
        </li>
      ))}
    </ul>
  );
}
