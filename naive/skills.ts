/** Playbook skills: one SKILL.md per playbook (spec §2), pushed to Naïve by slug. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PLAYBOOKS, type Playbook } from "../src/lib/domain";

export const skillSlug = (playbook: Playbook) => `playbook-${playbook}`;

export interface SkillSource {
  slug: string;
  playbook: Playbook;
  description: string;
  content: string;
  sha256: string;
}

const SKILLS_DIR = path.join(import.meta.dirname, "skills");

/** Naïve shows this text on every turn (tier 1), so it is taken from the frontmatter and kept short. */
function frontmatterDescription(content: string): string {
  const m = /^---\n[\s\S]*?^description:\s*(.+)$[\s\S]*?^---/m.exec(content);
  if (!m) throw new Error("SKILL.md is missing a frontmatter description");
  return m[1].trim();
}

export function loadSkill(playbook: Playbook, dir = SKILLS_DIR): SkillSource {
  const content = readFileSync(path.join(dir, playbook, "SKILL.md"), "utf8");
  return {
    slug: skillSlug(playbook),
    playbook,
    description: frontmatterDescription(content),
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export const loadAllSkills = (dir = SKILLS_DIR) => PLAYBOOKS.map((p) => loadSkill(p, dir));
