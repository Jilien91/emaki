// Checks that the pre-paint palette table in index.html still matches PALETTES
// in app.js.
//
//   node scripts/palette-bootstrap-test.js
//
// The inline script in index.html has to set data-palette and data-skin before
// anything paints, and it cannot reach app.js to ask: two blocking scripts sit
// between them. So the id-to-skin mapping is written out twice. That is a
// deliberate duplication and this is the thing that stops it rotting — add a
// palette to app.js and forget the bootstrap, and a reader on the new palette
// gets a flash of Classic on every load, which is precisely the bug the
// bootstrap exists to prevent.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// app.js: every { id:'x', ... skin:'y' } inside the PALETTES array.
const palettesStart = APP.indexOf('const PALETTES');
if(palettesStart < 0) throw new Error('app.js has no PALETTES array');
const palettesEnd = APP.indexOf('\n];', palettesStart);
const block = APP.slice(palettesStart, palettesEnd);

const fromApp = {};
for(const entry of block.split(/\{\s*id:/).slice(1)){
  const id = (entry.match(/^\s*'([a-z]+)'/) || [])[1];
  const skin = (entry.match(/skin:\s*'([a-z]+)'/) || [])[1];
  if(id) fromApp[id] = skin;
}

// index.html: the skins object in the bootstrap.
const m = HTML.match(/var skins = \{([\s\S]*?)\};/);
if(!m) throw new Error('index.html has no pre-paint skins table');
const fromHtml = {};
for(const pair of m[1].matchAll(/([a-z]+)\s*:\s*'([a-z]+)'/g)){
  fromHtml[pair[1]] = pair[2];
}

const ids = new Set([...Object.keys(fromApp), ...Object.keys(fromHtml)]);
let failed = 0;
for(const id of [...ids].sort()){
  const a = fromApp[id], h = fromHtml[id];
  const ok = a !== undefined && a === h;
  if(!ok) failed++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + id +
    (ok ? '  ' + a
        : '  app.js: ' + (a === undefined ? 'absent' : a) +
          ', index.html: ' + (h === undefined ? 'absent' : h)));
}

if(Object.keys(fromApp).length === 0){ console.log('FAIL  no palettes parsed out of app.js'); failed++; }

console.log(failed === 0
  ? '\nthe pre-paint palette table matches PALETTES'
  : '\n' + failed + ' palette(s) out of step between app.js and index.html');
process.exit(failed ? 1 : 0);
