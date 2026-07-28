// Metro, configured for a monorepo + NativeWind.
//
// The two monorepo settings are not optional: without `watchFolders` Metro does
// not see edits in ../../packages, and without `nodeModulesPaths` it cannot
// resolve dependencies that npm hoisted to the workspace root.
const path = require("node:path");

const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = withNativeWind(config, { input: "./global.css" });
