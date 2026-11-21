import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { standalone, artifactPage } from './shell.js';

const SHELL = standalone('%%BUNDLE%%');
const res = await build({
  entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, legalComments: 'none',
  alias: { three: path.resolve('../vendor/three.module.js') }, define: { __SHELL__: JSON.stringify(SHELL) }, charset: 'ascii',
});
let js = res.outputFiles[0].text;
js = js.replace(/<\/script/gi, '<\\/script');               // never let the bundle close its own script tag
fs.mkdirSync('../dist', { recursive: true });
fs.writeFileSync('../dist/blade-and-brew.html', SHELL.replace('%%BUNDLE%%', () => js));
fs.writeFileSync('../dist/artifact-page.html', artifactPage(js));
console.log('standalone', (fs.statSync('../dist/blade-and-brew.html').size / 1024).toFixed(0), 'KB; artifact', (fs.statSync('../dist/artifact-page.html').size / 1024).toFixed(0), 'KB');
