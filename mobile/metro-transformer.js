const path = require('path');

const expoTransformer = require(require.resolve('@expo/metro-config/babel-transformer', {
  paths: [path.dirname(require.resolve('expo/package.json'))],
}));

const PDFJS_PATH = /[\\/]pdfjs-dist[\\/]/;

// pdf.js is written for browsers and Node. Hermes (React Native's JavaScript engine) cannot parse
// two constructs it uses, so they are replaced before Babel runs:
//  - import.meta.url, used only by the Node.js branches;
//  - a dynamic import of a computed worker path, reached only when no worker was registered on
//    globalThis.pdfjsWorker. The app always registers it (see src/core/documents/extractText.ts).
const REPLACEMENTS = [
  [/import\.meta\.url/g, '""'],
  [
    /import\(\/\*webpackIgnore: true\*\/this\.workerSrc\)/g,
    'Promise.reject(new Error("pdf.js worker file is not available in this build"))',
  ],
];

module.exports.transform = function transform(params) {
  if (PDFJS_PATH.test(params.filename)) {
    let src = params.src;
    for (const [pattern, replacement] of REPLACEMENTS) {
      src = src.replace(pattern, replacement);
    }
    return expoTransformer.transform({ ...params, src });
  }
  return expoTransformer.transform(params);
};
