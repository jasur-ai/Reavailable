const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Hermes cannot parse `import.meta`, which pdf.js uses only in its Node.js branches.
// The transformer below rewrites that expression for pdf.js files and then runs Expo's usual Babel pipeline.
config.transformer = {
  ...config.transformer,
  babelTransformerPath: path.join(__dirname, 'metro-transformer.js'),
};

module.exports = config;
