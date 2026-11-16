// The app sits outside the root npm workspace and uses the shared packages
// (tc-protocol, tc-crypto, tc-client) straight from their folders one level up.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);

// Let Metro read and watch the shared packages.
config.watchFolders = [
  path.join(repoRoot, 'tc-protocol'),
  path.join(repoRoot, 'tc-crypto'),
  path.join(repoRoot, 'tc-client'),
];

// Their own dependencies (zod, tweetnacl, ed2curve) are installed here, with the app.
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];

module.exports = config;
