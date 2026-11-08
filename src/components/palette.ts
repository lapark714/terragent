/**
 * Layer colours as hex for WebGL and SVG (the globe can't read CSS variables).
 * Same values as the --color-<layer> tokens in src/app/globals.css.
 */
import type { Layer, Playbook } from "@/lib/domain";

export const LAYER_HEX: Record<Layer, string> = {
  disasters: "#d9434f",
  forest: "#1ba294",
  mining: "#b28e1e",
  inbound: "#7f83f0",
};

export const PLAYBOOK_LAYER: Record<Playbook, Layer> = {
  disasters: "disasters",
  deforestation: "forest",
  mining: "mining",
  inbound: "inbound",
};

export const playbookHex = (p: Playbook) => LAYER_HEX[PLAYBOOK_LAYER[p]];

export const LAYER_LABEL: Record<Layer, string> = {
  disasters: "Disasters",
  forest: "Forest loss",
  mining: "Mining",
  inbound: "Inbound requests",
};

export const PLAYBOOK_LABEL: Record<Playbook, string> = {
  disasters: "Disasters",
  deforestation: "Deforestation",
  mining: "Mining",
  inbound: "Inbound",
};

/** Background utility per playbook, spelled out so Tailwind sees the class names. */
export const PLAYBOOK_BG: Record<Playbook, string> = {
  disasters: "bg-disasters",
  deforestation: "bg-forest",
  mining: "bg-mining",
  inbound: "bg-inbound",
};
