/**
 * Usage: npm run bundle:pipeline
 * Packs pipeline/ (without .venv, tests, caches) into dist/pipeline-bundle.tgz for the Analytics agent's computer
 * and prints its size and sha256. Same sources, same sha256: upload a new Naïve File only when it changes.
 */
import { buildPipelineBundle } from "../src/lib/imagery/bundle";

const bundle = await buildPipelineBundle();
console.log(`[bundle] ${bundle.path}: ${bundle.files.length} files, ${(bundle.bytes / 1024).toFixed(1)} KiB`);
console.log(`[bundle] sha256 ${bundle.sha256}`);
