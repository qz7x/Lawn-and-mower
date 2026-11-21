// Shared page shell for the standalone file and the artifact page.
export const TITLE = 'Blade & Brew';

export const CSS = `
:root{--ink:#f4ecd8;--dim:#b9ad92;--amber:#f2a900;--amber2:#ffcf4d;--grass:#79c63f;--red:#e5482d;--panel:rgba(20,17,12,.72);--line:rgba(255,226,160,.18);color-scheme:dark;
 --display:'Alfa Slab One','Rockwell','Georgia',serif;--ui:'Barlow Condensed','Oswald','Arial Narrow',system-ui,sans-serif;--body:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif}
html,body{margin:0;height:100%;background:#0d0b08;color:var(--ink);overflow:hidden;font:14px/1.45 var(--body)}
canvas#c{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}
#fx{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 55%,transparent 55%,rgba(10,6,0,.55) 100%);z-index:2}
#warm{position:fixed;inset:0;pointer-events:none;z-index:2;background:radial-gradient(ellipse at 50% 50%,rgba(255,170,40,.0) 40%,rgba(255,150,30,.35) 100%);opacity:0;transition:opacity .6s}
[hidden]{display:none!important}
.hud{position:fixed;z-index:5;pointer-events:none;font-family:var(--ui);letter-spacing:.04em;text-transform:uppercase;text-shadow:0 1px 6px rgba(0,0,0,.7)}
.glass{background:var(--panel);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:10px}
#top{top:max(12px,env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);text-align:center;min-width:240px;padding:8px 18px 10px}
#timer{font:700 40px/1 var(--ui);letter-spacing:.06em}
#pctbar{height:8px;border-radius:5px;background:rgba(255,255,255,.12);overflow:hidden;margin:6px 0 2px}
#pctfill{height:100%;width:0;background:linear-gradient(90deg,#5aa826,#a5e04a);transition:width .25s}
#pcttxt{font-size:15px;color:var(--dim)}
#board{top:max(12px,env(safe-area-inset-top,0px));right:max(12px,env(safe-area-inset-right,0px));min-width:190px;padding:8px 12px}
#board div{display:flex;gap:8px;align-items:center;font-size:17px;padding:1px 0}
#board i{width:11px;height:11px;border-radius:3px;display:inline-block}
#board b{margin-left:auto;font-weight:600;color:var(--amber2)}
#roomtag{font-size:13px;color:var(--dim);margin-bottom:3px}
#gauges{left:max(14px,env(safe-area-inset-left,0px));bottom:max(14px,env(safe-area-inset-bottom,0px));padding:10px 14px;min-width:230px}
#spdrow{display:flex;align-items:baseline;gap:6px}#spd{font:700 46px/1 var(--ui)}#spdrow i{font-style:normal;color:var(--dim);font-size:16px}
.g{display:grid;grid-template-columns:54px 1fr 40px;gap:8px;align-items:center;font-size:14px;color:var(--dim);margin-top:5px}
.g .bar{height:9px;border-radius:5px;background:rgba(255,255,255,.12);overflow:hidden}.g .bar b{display:block;height:100%;width:50%;background:var(--amber);transition:width .2s}
.g output{color:var(--ink);text-align:right}
#bagmode{margin-top:6px;font-size:13px;color:var(--dim)}#bagmode b{color:var(--grass)}
#drink{left:50%;bottom:max(14px,env(safe-area-inset-bottom,0px));transform:translateX(-50%);display:flex;gap:18px;padding:8px 16px;align-items:center}
.can{width:20px;height:38px;border-radius:5px 5px 4px 4px;background:linear-gradient(90deg,#b8800c,#f6d365 40%,#c99510);position:relative;overflow:hidden;border:1px solid rgba(0,0,0,.4)}
.can u{position:absolute;left:0;right:0;bottom:0;background:rgba(40,20,0,.78);height:0;transition:height .3s}
.can i{position:absolute;left:0;right:0;top:14px;height:10px;background:#7a1212}
.stat{font-size:14px;color:var(--dim);line-height:1.15}.stat b{display:block;color:var(--ink);font-size:20px}
.cigar{width:56px;height:9px;border-radius:5px;background:linear-gradient(#7a4a26,#4b2c14);position:relative;overflow:visible}
.cigar em{position:absolute;right:-3px;top:-1px;width:9px;height:11px;border-radius:50%;background:#ff5a1a;box-shadow:0 0 10px 2px rgba(255,100,20,.8);opacity:.6}
#mini{right:max(14px,env(safe-area-inset-right,0px));bottom:max(14px,env(safe-area-inset-bottom,0px));padding:6px}
#mini canvas{display:block;width:176px;height:176px;border-radius:6px;image-rendering:pixelated}
#toast{left:50%;top:22%;transform:translateX(-50%);font:700 30px/1.1 var(--ui);text-align:center;opacity:0;transition:opacity .35s;white-space:nowrap}
#count{left:50%;top:38%;transform:translate(-50%,-50%);font:400 150px/1 var(--display);color:var(--amber2);opacity:0;text-shadow:0 6px 30px rgba(0,0,0,.7)}
#hint{left:50%;top:136px;transform:translateX(-50%);font-size:15px;color:var(--ink);opacity:.85;text-align:center;transition:opacity 1s;white-space:nowrap}
.menu{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));
 background:linear-gradient(180deg,rgba(8,6,3,.25),rgba(8,6,3,.72));overflow:auto}
.card{width:min(560px,100%);padding:26px 28px;background:rgba(18,15,10,.82);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.55)}
.title{font:400 clamp(40px,8vw,66px)/.95 var(--display);color:var(--amber2);margin:0;letter-spacing:.01em}
.title span{color:var(--grass)}
.sub{font:600 18px/1.2 var(--ui);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:8px 0 18px}
.row{display:flex;gap:10px;flex-wrap:wrap}.col{display:flex;flex-direction:column;gap:10px}
button.btn{font:700 20px var(--ui);letter-spacing:.08em;text-transform:uppercase;color:#1a1305;background:linear-gradient(#ffd75a,#f2a900);border:0;border-radius:9px;padding:12px 18px;cursor:pointer;box-shadow:0 3px 0 #9a6a00,0 8px 18px rgba(0,0,0,.4);text-align:left}
button.btn:hover{filter:brightness(1.08)}button.btn:active{transform:translateY(2px);box-shadow:0 1px 0 #9a6a00}
button.btn.alt{color:var(--ink);background:linear-gradient(#3b342a,#2a251d);box-shadow:0 3px 0 #14100a,0 8px 18px rgba(0,0,0,.4)}
button.btn small{display:block;font:500 13px var(--body);letter-spacing:0;text-transform:none;opacity:.75;margin-top:1px}
button.btn:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--grass);outline-offset:2px}
label.f{display:block;font:600 14px var(--ui);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:12px 0 4px}
input.t,select.t,textarea.t{width:100%;box-sizing:border-box;background:#120f0a;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:9px 11px;font:15px var(--body)}
textarea.t{height:84px;font:12px ui-monospace,Menlo,monospace;resize:vertical}
.sw{display:flex;gap:8px}.sw button{width:34px;height:34px;border-radius:8px;border:2px solid transparent;cursor:pointer}.sw button[aria-pressed=true]{border-color:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.5)}
.keys{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:14px;color:var(--dim)}.keys b{color:var(--ink);font:600 15px var(--ui);letter-spacing:.06em}
.muted{color:var(--dim);font-size:13px}.ok{color:var(--grass)}.warn{color:var(--amber2)}.bad{color:#ff7a63}
.list{margin:8px 0 0;padding:0;list-style:none}.list li{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font:600 20px var(--ui);letter-spacing:.04em}.list li b{margin-left:auto;color:var(--amber2)}
.tabs{display:flex;gap:6px;margin:6px 0 10px;flex-wrap:wrap}.tabs button{flex:1;min-width:120px;font:700 16px var(--ui);letter-spacing:.08em;text-transform:uppercase;padding:9px 6px;border-radius:8px;border:1px solid var(--line);background:#1b1710;color:var(--dim);cursor:pointer}.tabs button[aria-selected=true]{background:var(--amber);color:#1a1305}
a{color:var(--amber2)}
@media (max-width:640px){#board{top:auto;bottom:210px}#mini canvas{width:120px;height:120px}#gauges{min-width:190px}#count{font-size:110px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export const BODY = `
<canvas id="c" tabindex="0"></canvas>
<div id="fx"></div><div id="warm"></div>
<div id="hud" hidden>
  <div id="top" class="hud glass"><div id="roomtag" hidden></div><div id="timer">3:00</div><div id="pctbar"><div id="pctfill"></div></div><div id="pcttxt">0% mowed</div></div>
  <div id="board" class="hud glass" hidden></div>
  <div id="gauges" class="hud glass">
    <div id="spdrow"><span id="spd">0</span><i>km/h</i></div>
    <div class="g"><span>Fuel</span><div class="bar"><b id="fuelbar"></b></div><output id="fuelv">100</output></div>
    <div class="g"><span>Bag</span><div class="bar"><b id="bagbar" style="background:var(--grass)"></b></div><output id="bagv">0</output></div>
    <div id="bagmode"></div>
  </div>
  <div id="drink" class="hud glass">
    <div class="can"><i></i><u id="canfill"></u></div>
    <div class="stat">Beer<b id="beerN">6</b></div>
    <div class="stat">Cigar<div class="cigar" id="cigar"><em id="ember"></em></div></div>
  </div>
  <div id="mini" class="hud glass"><canvas id="minic" width="256" height="256"></canvas></div>
  <div id="toast" class="hud"></div><div id="count" class="hud"></div>
  <div id="hint" class="hud"></div>
</div>
<div id="menu" class="menu" hidden></div>
`;

/** Full standalone document (bundle injected at %%BUNDLE%%). */
export function standalone(bundlePlaceholder = '%%BUNDLE%%') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Blade &amp; Brew</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap">
<style>${CSS}</style></head><body>${BODY}<script id="bnb-bundle">${bundlePlaceholder}</script></body></html>`;
}
/** Artifact page: the platform supplies the document skeleton. */
export function artifactPage(bundle) {
  return `<title>Blade &amp; Brew</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap">
<style>${CSS}</style>
${BODY}<script id="bnb-bundle">${bundle}</script>`;
}
