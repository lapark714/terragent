<role>
You are a motion director and creative technologist. You design, animate, score and QA a finished film entirely in code, in Remotion. Judge every choice against the best product-launch and explainer films from top AI and developer-tools companies. A film with no bugs is not finished; it's finished when it holds up next to that work. These instructions are the floor, not the ceiling. If anything conflicts, the brief wins, then these defaults.
</role>

<context>
Terragent is an AI-agent-run geospatial intelligence company, built in 22 hours for the Naïve Autonomous Company Hackathon (YC office, San Francisco). Judges score one thing above all: "how much of the company runs without you." There are also category prizes for Most Autonomous Company, Best Use of Naïve, Most Likely to Become a Unicorn and Best Design.

This film is a self-contained 60-second segment that gets cut into the team's longer demo video. Before it, the founders appear on camera with the intro, the hook and the problem. Their last line is "Here's how that happens." Then this clip plays. Nobody narrates it, live or recorded: on-screen type, motion and sound carry every idea alone. It must make complete sense to someone who watches only this clip, with the sound off. It has two halves:
1. How it works (0–30 s): the autonomous machine, as a living flow chart.
2. What you could ask (30–60 s): a fast run of scenarios across industries and data types.

This film sells the vision: what Terragent does once it has the data, the requests and the right analysis. Show the full ambition boldly. Even so, never fabricate customers, testimonials, revenue, ratings, or real company logos.
</context>

<brief>
mode:        explainer (first half) into product montage (second half). One continuous film, not two clips.
subject:     Terragent: ask any question about any place on Earth; a team of AI agents finds the right satellite data, analyzes it, verifies it, and delivers the answer. It also finds customers, prices work and gets paid, all on its own.
viewer:      Hackathon judges (YC partners, sponsors, engineers) watching on a big screen. They have seen 40 demos today and care about real autonomy, technical depth and scale of ambition.
end state:   "This company runs itself, and it can answer anything about the planet." They remember the globe-pin and the line "Ask about any place on Earth."
length:      60 s exactly, 16:9, 1920×1080. No 9:16.
frame rate:  60 (UI, data and type-led motion).
brand:       See <style_bible>. Real logo files only; never redraw the logo.
facts:       The <facts> block below is the only source for words on screen.
assets:      See <assets>.
style:       Mission-control precision meets a premium product launch. Dark navy night-side Earth, thin instrument lines, wide-set display type, data that animates. Think orbital camera, then clean diagrams, then satellite imagery resolving into answers. No stock footage, no cartoon robots, no glowing brain icons.
sound:       Music + sfx only. No voice, no narration, no captions of speech. On-screen type does all the explaining, so every beat must read with the sound off. The clip is edited into a longer video, so also export stems (music-only and sfx-only) in case the editor swaps the music.
autonomy:    Unattended: never stop. Judging is tomorrow morning; make every ◆ decision yourself, log it in brief.md, and keep going.
toolchain:   Remotion (React). Use @remotion/three for the globe only. Everything else is SVG/HTML driven by useCurrentFrame, interpolate and spring.
sign-off:    The Terragent lockup over a slowly turning globe, then "Ask about any place on Earth." and "Run by AI agents."
</brief>

<carrying_object>
The founders' mark is a globe on a map-pin spike, circled by an orbit with a small satellite. That pin carries the film:
- 0 s: the pin drops onto the globe. The question lands there.
- Through the flow chart, the satellite dot travels the orbit, and each orbit stop is an agent. The pin's tip is the cursor that "hands off" between nodes, on the same pixels on both sides of every cut.
- In the scenarios, the pin drops on each new place, and the camera dives from orbit to that spot.
- At the end, the pin settles into the logo lockup.
</carrying_object>

<storyboard_draft>
Refine this; don't copy it blindly. Keep the beats, fix the timing to the music, and write the final table in brief.md.

HALF 1: HOW IT WORKS (0–30 s). The flow chart is drawn live on top of a dimmed, slowly turning globe. Nodes are glass panels on the hairline grid, and edges draw themselves as signal pulses.

| t | On screen | Purpose |
|---|---|---|
| 0.0–3.0 | Globe fills frame. The pin drops. Three inputs fly in and converge on the pin: an email bubble ("Did the fire reach our vineyard?"), a tap on the web globe, and an API/MCP call in mono type. | Anyone, any channel, any question. |
| 3.0–7.0 | Split screen: "…or we find you first." Live feeds tick in as small labelled chips (NOAA weather alerts, NASA fire detections, USGS earthquakes, river flood gauges, FEMA declarations, Global Forest Watch alerts, mining claim filings, news). Each fires a dot on the globe, a "Sourcing agent" matches it to a business's site, and an "Outreach agent" drafts a short AI-disclosed email with a free sample analysis. | Autonomous demand: the signal engine. |
| 7.0–11.0 | The Planner node opens a data spec card: exact area (an H3 hex outline), the dates to compare, the sensor, the method. It checks the "Earth index" first: a hex lights up as "already known". | Brain: planning plus the compounding index. |
| 11.0–16.0 | Data routing, the hero diagram. The Acquisition agent fans out to sources, free first: Sentinel-2, Landsat, Sentinel-1 radar. Then a paid tier: commercial 30 cm optical, SAR, thermal, hyperspectral, from marketplaces. The Pricing agent assembles three options into a quote card; the customer taps one; payment confirms (a check and a receipt chip). | Data routing plus pricing plus payment, with no human. |
| 16.0–21.0 | The Analytics agent runs in a sandboxed cloud computer (terminal lines scroll: water extent, burn severity, vegetation change). The Interpreter writes the answer. The Verifier grades it against a checklist; one draft is rejected and loops back (a red arc), then passes (a green check with score 92/100). | Deep analysis, and quality without humans. |
| 21.0–25.0 | Delivery: the report card assembles, with answer, before/after imagery, confidence, sources and limitations. It is emailed in the same thread with a share link. The answered hex joins the Earth index, which visibly grows across the globe. | Delivery plus compounding data asset. |
| 25.0–30.0 | Pull back to mission control: 12 agent nodes in orbit around the pin (Coordinator, Customer comms, Supplier comms, Outreach, Planner, Acquisition, Pricing, Interpreter, Analytics, Verifier, Sourcing, Market research), pulsing as work flows. Counters tick: requests answered, emails sent, quotes paid. A "Human interventions" counter stays near zero. Full-frame type: "The whole company runs itself." Small credit line: "Orchestrated on Naïve." | The hackathon thesis, in one picture. |

HALF 2: WHAT YOU COULD ASK (30–58 s). A fast, rhythmic montage. Each scenario follows the same visual grammar but never the same layout:
- The question appears in plain language, typed.
- The pin drops, and the camera dives from orbit to the place.
- A data-type chip appears (which sensor and why).
- The imagery resolves: before → after, or the index overlay sweeps across.
- An answer card lands with one number and a confidence meter.
Target about 4 s each; speed up toward the end, then hold the last one a beat longer.

1. Disaster / insurance: "Which of our 40 warehouses flooded last night?" Radar (SAR) sees through the storm clouds at night. Flood extent paints in blue. "7 of 40 sites under water · High confidence."
2. Wildfire / property: "Did the fire reach this vineyard?" Burn severity (dNBR) heat map; the property boundary lights up. "Fire stopped 340 m from the vines."
3. Agriculture / food: "Which of my fields are drought-stressed this week?" Vegetation index plus thermal. Fields tint from green to amber. "3 fields need water first."
4. Supply chain / compliance: "Was this cocoa farm cleared after 2020?" A Sentinel-2 time series scrubs year by year, with forest-loss alerts and an EU deforestation rule check. "No clearing detected since Dec 2020 · Compliant."
5. Mining / exploration: "Any signs of iron-oxide alteration on this claim?" Hyperspectral bands split into a rainbow, and mineral indicator pixels glow ochre. "Strong iron-oxide indicators in the NE quadrant." The word is always "indicators", never "deposits".
6. Energy / climate: "Is this pipeline leaking methane?" Methane-sensing satellite plume overlay. "Plume detected · est. 120 kg/h."
7. Infrastructure / economics: "How fast is this factory expanding?" High-resolution change detection: new roofs outlined, plus a growth chart. "+18% built area in 6 months."
8. Wildcard rapid-fire (about 3 s, 4–5 tiny tiles in a grid, each a question plus a sensor chip): coastline erosion, glacier retreat, port congestion, solar-farm build-out, illegal-fishing night lights.

| 58–60 | Every scenario pin lifts off and converges into one pin, which becomes the Terragent lockup over the turning globe. "Ask about any place on Earth." Smaller: "Run by AI agents." | Sign-off. |

Scenario numbers are illustrative. Set them in the same type system as real data so they read as a confident product, but in the half-2 opener put a small tag: "What you could ask". This keeps it a vision without lying.
</storyboard_draft>

<facts>
Grounded in the product (use freely):
- Twelve AI agents: Coordinator, Customer comms, Supplier comms, Outreach, Planner, Acquisition, Pricing, Interpreter, Analytics, Verifier, Sourcing, Market research.
- Requests arrive by email, on the website (pick a place on a globe or type an address/coordinates), by API, or via an MCP endpoint for other AI agents.
- The signal engine watches live public feeds: NOAA/NWS weather alerts, NASA FIRMS fire detections, USGS earthquakes, NOAA river flood gauges, OpenFEMA disaster declarations, Global Forest Watch deforestation alerts, BLM mining claims, USGS mineral records, and news. It matches events to businesses' sites and sends one AI-disclosed outreach email with a free sample analysis.
- The Planner writes a data spec (area, dates, sensor, method) and checks Terragent's own Earth index (an H3 hexagon grid of everything it has measured) first.
- Free data first: Sentinel-2 and Landsat. When paid imagery would answer better, the agents price it from satellite marketplaces.
- Pricing: agents quote up to three options; nothing runs until the customer accepts one.
- Analysis runs server-side in a sandboxed cloud computer, using established methods: water extent, burn severity, vegetation change, before/after change detection.
- A separate Verifier agent grades every report against a checklist and sends weak ones back.
- Reports contain a plain answer, before/after images with capture dates, measurements, a confidence level, every source with dates, limitations, and a human-review note when stakes are high.
- Everything is logged on mission control, including every time a human steps in.
- Stack: Naïve managed agents (orchestration and compute), AgentMail (agent email inboxes), Monid (paid data and API access), Neon Postgres.

Vision (allowed on screen as capability):
- More sensor types: SAR radar, thermal, hyperspectral, methane, 30 cm commercial optical, night lights, LiDAR elevation.
- Agents collect payment autonomously.
- The Earth index compounds: every answer makes the next one faster and cheaper.

Never: fake customer names or logos, testimonials, revenue or user counts, investment or token language, or the word "deposits" for minerals.
</facts>

<style_bible>
Colours (exact hex; ≤6 used per scene):
- space #0a1523 (background), panel #0e1c2d, raised #142739, line #1d3249, line-strong #2c4864
- text #e7eef6 · secondary #a6b7ca · tertiary #7d92a9
- accent / Terragent periwinkle #7f83f0 (hi #9a9df5): the pin, active edges and CTAs
- layer colours, used only as data meaning: disasters #d9434f, forest/vegetation #1ba294, mining/minerals #b28e1e, inbound #7f83f0, water #4aa3df (SAR flood), human-intervention pink #f2a7c0, alert #f08a7a
Type:
- Display: Archivo variable with the width axis at 125% (wide) for headlines, semibold, tight tracking (−0.025em). Body: Archivo at normal width.
- Mono: JetBrains Mono for agent names, sensor chips, coordinates, terminal lines and numbers.
- Pin the fonts locally (Google Fonts files in the project).
Textures and motifs:
- Hairline instrument grid: panels separated by 1 px lines in #1d3249.
- H3 hexagon field, faint, fading from one corner.
- Night-side Earth with a periwinkle atmosphere glow.
- Pulsing "beacon" dots for live things.
- A segmented progress bar (the product's step track) for any pipeline progress.
Motion vocabulary:
- Edges draw as travelling pulses. Nodes spring open with a slight overshoot.
- Numbers count up with easing.
- Imagery resolves by a mask sweep (like a satellite pass), never a cross-fade.
- The camera dives along an arc from orbit.
- Everything settles with follow-through; nothing pops on or off linearly.
</style_bible>

<assets>
- Logo: two PNGs, white on transparent. Use them as masks filled with #e7eef6:
  - mark (globe-pin): ~/Downloads/terragent-mark-white.png
  - lockup (mark plus lowercase serif "terragent"): ~/Downloads/terragent-lockup-white.png
  - The black-on-white originals are "terragent logo.png" and "terragent (2 x 0.5 in).png" in ~/Downloads.
  - There is no SVG. Do not redraw or trace the logo. For the pin animations, animate the PNG mark as a unit (scale, drop, settle).
- Globe texture: ~/Code/terragent/public/globe/earth-night.jpg, with bump map earth-topology.png alongside it.
- Satellite imagery for close-ups: Sentinel-2 cloudless 2016 tiles by EOX (CC BY 4.0). Show the credit "Sentinel-2 cloudless 2016 © EOX" in small type whenever they're on screen.
  - Tile URL: https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg
  - Download and pin the tiles locally before rendering.
- Sensor looks you can't source (SAR, thermal, hyperspectral, methane) are generated in code as stylized overlays: noise-free, data-like colour ramps on top of the real optical tile. Keep them clearly diagrammatic.
- Product UI to rebuild as live components (study, don't screenshot): the landing globe with the "Where on Earth?" search, the request status page (step track, "agent is on it" card, timeline) and the report page (answer, confidence meter, before/after slider, measurement cards). Source: ~/Code/terragent/src/components/{site,request,report}. Run `npm run dev:local` in ~/Code/terragent to see them at localhost:3000; it's offline demo data. Never use the live site.
</assets>

<on_screen_copy>
There is no narrator, so the words on screen are the script. Keep every line short, big and on screen long enough to read (~0.3 s per word, 0.7 s minimum). One idea per line. Never more than about 8 words visible at once outside the answer cards. Suggested section titles and key lines; refine for rhythm, but keep the meaning:
- 0 s: "Ask anything. Anywhere on Earth."
- 3 s: "Or we find you first."
- 7 s: "An agent plans the job."
- 11 s: "Routes it to the right satellites."
- 13.5 s: "Prices it. Gets paid."
- 16 s: "Analyzes it. Checks its own work."
- 21 s: "Delivers the answer."
- 25 s: "12 agents. Zero humans in the loop."
- 30 s: "What you could ask"
- 58 s: "Ask about any place on Earth." / "Run by AI agents."
Agent names, sensor names and data labels are set small in mono, as diagram labels, not as sentences.
</on_screen_copy>

<craft>
1. Frame one is a finished picture: the globe with the pin mid-drop works as a still.
2. The pin carries the film and lands on the same pixels on both sides of every handoff.
3. Transitions are made of content: a node expands into the next scene, the camera dives through the pin into the imagery, a quote card flips into a receipt. Hard cuts only on a beat, when size and direction match.
4. One lead movement with overlapping secondary ones. Nothing starts or stops all at once.
5. Speed always changes: arrive slowly enough to read, leave fast. No linear easing; use springs, anticipation and arcs.
6. Every action has a visible result. A tap produces a check. An email produces an inbox bubble. A rejection loops back. A payment produces a receipt.
7. Type is motion: it masks and reveals. Allow ~0.3 s per word (0.7 s minimum). Questions in half 2 can type on fast, but each must stay fully readable for at least 1.2 s. Never place type over busy imagery without a panel.
8. Vary scale and layout: orbit wide, node macro, overhead map, full-frame type, grid of tiles. Never repeat a layout across consecutive scenes.
9. Holds breathe: the globe keeps turning, beacons pulse, counters tick. Nothing freezes.
10. 3D only for the globe and the orbital dives. Camera at 35–55°, with atmosphere glow. Labels are HTML tracked to the 3D positions.
11. Every effect earns its place. No decorative particles, lens flares, generic gradients or glitch effects.
</craft>

<audio>
Audio comes first, and the picture is cut to it.
- Music: modern, confident, minimal electronic. A pulse under half 1 that builds. A lift or drop exactly at 30 s for the montage. A tighter rhythm through half 2. A resolve on the lockup at 58 s. Never name a brand or artist in a music prompt.
- Beat-detect and write timing.json: beats, the 30 s drop, the scenario cuts, the lockup. All animation timing reads from it.
- SFX only for real events, each in its own frequency band just above the music:
  - a soft tick per node opening
  - a data-pulse whoosh per edge
  - the pin drop thud
  - a click on "accept"
  - a cash-register-free soft chime on payment
  - a low buzz on the verifier reject, and a bright tick on pass
- Mix to about −14 LUFS, true peak ≤ −1 dBTP. Export the full mix, a music-only stem and an sfx-only stem.
- The clip is spliced between on-camera talking segments. Start with a short rise from silence (no hard downbeat on frame one) and end on a clean resolve with ~0.5 s of tail, so the editor can cut in and out cleanly.
</audio>

<build>
- One Remotion project and one root composition (60 s @ 60 fps = 3600 frames), with each scene its own component inside <Series>/<Sequence>. Write shared tokens (colours, fonts, eases, the pin's handoff positions) first.
- Every value is a function of the frame. No timers, no unseeded randomness. Use seeded noise for any data texture.
- Pin all fonts, tiles, textures and audio locally. Keep API keys in env vars.
- Render a 3–5 s test end to end before building the full film.
- Run scene builders in parallel once tokens and timing.json exist.
</build>

<workflow>
0. Read the codebase before designing anything (the repo is at ~/Code/terragent; read only, change nothing). If you can't reach it, everything you need is already copied into this prompt, so carry on.
   - What the company does and how it runs: README.md, terragent-master-prompt.md (§1 hackathon context, the pitch outline), NOTES.md (Decisions).
   - The agents, data and pipeline: src/lib/domain.ts (agent names, playbooks), src/lib/signals/ (the live feeds), src/lib/pipeline/, src/lib/imagery/.
   - The visual language: src/app/globals.css (the colour tokens and Archivo width axis), src/components/site/ask/ (globe, pin, search, details sheet), src/components/request/ (step track, agent card, timeline), src/components/report/ (answer, confidence meter, before/after slider, measurement cards), src/components/site/Logo.tsx.
   - To see it moving, run `npm run dev:local` in the repo and open localhost:3000. It's offline demo data. Never use or submit to the live site.
   Match what you build to this real product: the same tokens, the same component shapes, the same words for things.
1. Lock facts: copy <facts> into facts.json and tag each line as "grounded" or "vision". Collect the assets above.
2. Concept: write 2–3 one-paragraph directions, pick one, and name three signature moments without effect names. Defaults if you have no better idea:
   - the camera diving through the pin into a flooded town;
   - the verifier rejecting a draft and the loop snapping back;
   - twelve agents orbiting the pin with the human counter at zero.
3. Storyboard: finalize the table above against the music. It must read with the sound off.
4. Style frames: render three stills in code (the flow-chart hero, one scenario answer card, the lockup) and check them against the style bible.
5. Audio and timing map.
6. Build, assemble, and run the critic loop until the quality bar passes.
7. Deliver.
(Autonomy is unattended: make the ◆ decisions yourself and log them.)
</workflow>

<critic_loop>
The builder never judges its own work. After the storyboard, each scene and each full render, a fresh critic subagent pulls frames every 0.2 s (dense around transitions) and returns ranked problems with timestamps, ending in "ship" or "one more pass". Every full render also gets:
- Sound-off read: from a silent 2 fps contact sheet, can a critic retell (a) how the agents work and (b) at least five things you could ask?
- Sync: every hit within 1 frame of timing.json.
- Fact check: every on-screen word traced to facts.json, with vision claims only where they're tagged vision. No fake customers or logos.
- Director's review: a brutal critique of anything that feels like a template, a slideshow, or slow.
Fix the biggest problem first, re-render, and have a new critic recheck. Log each round in ledger.md.
</critic_loop>

<quality_bar>
- Exactly 60.000 s, 1920×1080, 60 fps.
- Frame one finished.
- No still stretch over 0.5 s; ≤2 s total near-frozen.
- Text contrast ≥4.5:1, nothing outside a 5% safe margin, no collisions.
- Brand hexes match in the render.
- Cuts and hits within 1 frame of the beat.
- ~−14 LUFS, no clipping.
- Understood with the sound off.
- Half 1 makes "fully autonomous" undeniable: demand, routing, pricing, payment, analysis, QA and delivery all shown without a human.
- Half 2 shows at least six distinct industries and at least five distinct sensor types.
- Logo used only from the supplied files.
- Judged: it would sit beside a top-tier AI product launch film without looking weaker.
</quality_bar>

<deliverables>
- terragent-how-it-works-60s.mp4 (full mix)
- music-only and sfx-only stems (WAV)
- a silent version of the MP4
- a 16-frame contact sheet
- brief.md, facts.json, style frames, timing.json, ledger.md, and the quality-bar results
- a short note on what a human should check by eye and ear before showing it to judges
</deliverables>
