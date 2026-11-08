/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);
// The globe needs WebGL in headless Chrome; ANGLE uses the Mac's GPU.
Config.setChromiumOpenGlRenderer("angle");
Config.setConcurrency(5);
Config.setJpegQuality(92);
