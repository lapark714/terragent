import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { SmallPin } from "../../components/Pin";
import { Chip, Mono, Panel } from "../../components/Primitives";
import { Sweep } from "./shared";
import { EASE, lerp, pop, prog } from "../../motion";
import { C, COPY, f, FONT, hit, TIMING } from "../../tokens";

const { from: FROM } = TIMING.scenes.rapid;
const TILE_W = 560;
const TILE_H = 396;
const GAP = 24;
const TOTAL_W = 3 * TILE_W + 2 * GAP;
const LEFT = (1920 - TOTAL_W) / 2;
const TOP = 84;

type Tile = { key: string; question: string; sensor: string; color: string; col: number; row: number; pan: readonly [number, number] };

const TILES: Tile[] = [
  { key: "coast", question: "How fast is this coast eroding?", sensor: "LiDAR elevation", color: C.alert, col: 0, row: 0, pan: [26, 8] },
  { key: "glacier", question: "How far has this glacier retreated?", sensor: "Sentinel-2 · optical", color: C.water, col: 1, row: 0, pan: [-16, 14] },
  { key: "port", question: "Is this port congested?", sensor: "SAR radar", color: C.accentHi, col: 2, row: 0, pan: [-24, -8] },
  { key: "solar", question: "How much solar went in here?", sensor: "30 cm optical", color: C.accentHi, col: 0.5, row: 1, pan: [18, -14] },
  { key: "fishing", question: "Any illegal fishing at night?", sensor: "Night lights", color: C.text, col: 1.5, row: 1, pan: [-20, 10] },
];

const tilePos = (t: Tile) => ({ x: LEFT + t.col * (TILE_W + GAP), y: TOP + t.row * (TILE_H + GAP) });

/** Tiles are gone before the pins fly. */
const EXIT_AT = (i: number) => f(55.9) - FROM + i * 6;
const EXIT_DUR = 22;
const TILES_GONE = EXIT_AT(4) + EXIT_DUR;
const END = f(57) - FROM;
const MERGE = { x: 960, y: 500 } as const;
/** The pin that becomes the film's pin arrives last, on the exact frame the global pin takes over. */
const LEAD = 2;

/** A single loop of the satellite pass, so a held tile keeps working. */
const scanOf = (frame: number, i: number) => (((frame + i * 19) % 84) / 84) * TILE_W;

const TileCard: React.FC<{ t: Tile; i: number; frame: number }> = ({ t, i, frame }) => {
  const at = hit(`rapid tile ${i + 1}`) - FROM;
  const s = pop(frame, at - 3, 16);
  const out = prog(frame, EXIT_AT(i), EXIT_DUR, EASE.in);
  const { x, y } = tilePos(t);
  const life = prog(frame, at, TILES_GONE - at, EASE.out);
  const push = 1.06 + life * 0.09;
  const scan = scanOf(frame, i);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: TILE_W,
        height: TILE_H,
        borderRadius: 8,
        overflow: "hidden",
        opacity: Math.min(1, s * 1.6) * (1 - out),
        transform: `translateY(${out * 90}px) scale(${lerp(0.86, 1, s) * (1 - out * 0.08)})`,
        border: `1px solid ${C.lineStrong}`,
        background: C.panel,
      }}
    >
      <div style={{ position: "absolute", inset: 0, transform: `translate(${t.pan[0] * life}px, ${t.pan[1] * life}px) scale(${push})`, filter: t.key === "glacier" ? "brightness(0.74)" : "brightness(0.86)" }}>
        <Img src={staticFile(`tiles/${t.key}.jpg`)} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover" }} />
        <Sweep from={at + 4} dur={18} color={t.color} w={TILE_W} h={TILE_H}>
          <Img src={staticFile(`overlays/rapid-${t.key}.png`)} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover" }} />
        </Sweep>
      </div>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: scan, width: 2, background: t.color, opacity: 0.55 * prog(frame, at + 22, 10) }} />
      <Chip from={at + 2} x={12} y={12} size={22} color={t.color}>
        {t.sensor}
      </Chip>
      <Panel x={12} y={TILE_H - 66} w={TILE_W - 24} style={{ padding: "10px 14px" }}>
        <div style={{ fontFamily: FONT.sans, fontSize: 28, fontWeight: 500, lineHeight: 1.1, color: C.text }}>{t.question}</div>
      </Panel>
    </div>
  );
};

export const Rapid: React.FC = () => {
  const frame = useCurrentFrame();
  const creditOut = prog(frame, EXIT_AT(2), EXIT_DUR, EASE.in);
  return (
    <>
      {TILES.map((t, i) => (
        <TileCard key={t.key} t={t} i={i} frame={frame} />
      ))}
      <Panel x={762} y={972} w={395} o={Math.min(prog(frame, 0, 8), 1 - creditOut)} style={{ padding: "6px 12px", borderRadius: 5, textAlign: "center", transform: `translateY(${creditOut * 40}px)` }}>
        <Mono size={18} color={C.text2}>
          {COPY.eox}
        </Mono>
      </Panel>
      {TILES.map((t, i) => {
        const at = hit(`rapid tile ${i + 1}`) - FROM;
        const { x, y } = tilePos(t);
        const px = x + TILE_W / 2;
        const py = y + TILE_H * 0.46;
        const land = pop(frame, at + 3, 12);
        const isLead = i === LEAD;
        // One after another, on separate arcs: none share pixels until the lead arrives.
        // Each pin leaves as its own tile clears, so none idles over an empty frame; the lead is last in.
        const start = isLead ? END - 30 : EXIT_AT(i) + EXIT_DUR - 6;
        const arrive = isLead ? END : start + 22;
        const lift = prog(frame, start, arrive - start, EASE.travel);
        const side = px < MERGE.x ? -1 : px > MERGE.x ? 1 : 0;
        const tipX = lerp(px, MERGE.x, lift) + side * Math.sin(lift * Math.PI) * 120;
        const tipY = lerp(py - lerp(46, 0, Math.min(land, 1)), MERGE.y, lift) - Math.sin(lift * Math.PI) * 170;
        const h = isLead ? lerp(72, 120, lift) : lerp(72, 48, lift);
        const gone = isLead ? 0 : prog(frame, arrive - 4, 4, EASE.in);
        return <SmallPin key={t.key} x={tipX} y={tipY} h={h} o={Math.min(1, land * 2) * (1 - gone)} />;
      })}
    </>
  );
};
