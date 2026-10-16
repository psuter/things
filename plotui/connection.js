import {Plotter} from './serial.js';
import {EmulatorPort} from './emulator.js';

const emulate=new URLSearchParams(location.search).get('emulate_plotter')==='true';
let activePort=null,frame=0,position={x:0,y:0,z:0};
const traces=[];
const byId=id=>document.getElementById(id);
function mountView(){
  const template=document.createElement('template');
  template.innerHTML=`<aside id="emulator-panel" class="emulator-panel" aria-label="Plotter position view"><header class="emulator-heading"><strong>AxiDraw</strong><div class="emulator-tools"><output id="emulator-pen">PEN UP</output><button id="emulator-clear" type="button" title="Clear pen marks">Clear</button><button id="emulator-hide" type="button" aria-label="Hide plotter">−</button></div></header><svg class="emulator-scene" viewBox="0 0 420 300" role="img" aria-label="AxiDraw and paper"><defs><pattern id="emulator-paper-grid" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M12 0H0V12" fill="none" stroke="#e5e9df" stroke-width=".7"/></pattern><filter id="emulator-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#23372e" flood-opacity=".18"/></filter></defs><rect class="emulator-table" x="17" y="15" width="386" height="270" rx="15"/><rect class="emulator-bed" x="45" y="35" width="330" height="233" rx="3"/><rect class="emulator-paper" x="67" y="56" width="286" height="190" rx="1"/><rect x="67" y="56" width="286" height="190" fill="url(#emulator-paper-grid)" pointer-events="none"/><path class="emulator-rail" d="M35 31V273M385 31V273"/><g id="emulator-trace" pointer-events="none"></g><g id="emulator-gantry"><rect class="emulator-beam" x="37" y="-7" width="346" height="14" rx="6"/><path class="emulator-belt" d="M42 0H378"/><g id="emulator-head" filter="url(#emulator-shadow)"><rect class="emulator-carriage" x="-16" y="-16" width="32" height="27" rx="5"/><circle class="emulator-wheel" cx="-10" cy="-8" r="2.4"/><circle class="emulator-wheel" cx="10" cy="-8" r="2.4"/><path class="emulator-pen-shaft" d="M0 8V20"/><path class="emulator-pen-nib" d="M-3 19L0 25L3 19Z"/></g></g><path class="emulator-cable" d="M365 29v12h-23v8"/><text class="emulator-brand" x="31" y="266">AXIDRAW</text><text class="emulator-paper-label" x="210" y="72" text-anchor="middle">PAPER</text></svg><div class="emulator-footer"><span id="emulator-readout">X 0.0 · Y 0.0 mm</span></div></aside><button id="emulator-show" class="emulator-show" type="button" hidden>Show plotter</button>`;
  document.querySelector('.plot-app').append(template.content);
}

function coordinates(point){
  const area=plotter.machine.envelope||{width:297,height:210},home=plotter.machine.home;
  let x,y;
  if(home){
    const xs=home.xSign??area.xSign??1,ys=home.ySign??area.ySign??-1;
    const localX=(point.x-home.x)*xs,localY=(point.y-home.y)*ys;
    x=home.corner?.endsWith('right')?area.width-localX:localX;
    y=home.corner?.startsWith('bottom')?area.height-localY:localY;
  }else{x=point.x;y=-point.y;}
  return{x:45+Math.max(0,Math.min(area.width,x))*330/area.width,y:35+Math.max(0,Math.min(area.height,y))*233/area.height};
}
function drawPosition(){
  frame=0;const p=coordinates(position);
  byId('emulator-gantry').setAttribute('transform',`translate(0 ${p.y-25})`);
  byId('emulator-head').setAttribute('transform',`translate(${p.x} 0)`);
  byId('emulator-readout').textContent=`X ${position.x.toFixed(1)} · Y ${position.y.toFixed(1)} mm`;
  byId('emulator-pen').textContent=activePort?.penDown?'PEN DOWN':'PEN UP';
  byId('emulator-panel').classList.toggle('pen-down',!!activePort?.penDown);
}
function receive(detail){
  if(detail.type==='segment'){
    const a=coordinates({x:detail.x1,y:detail.y1}),b=coordinates({x:detail.x2,y:detail.y2});
    const line=document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',a.x);line.setAttribute('y1',a.y);line.setAttribute('x2',b.x);line.setAttribute('y2',b.y);line.setAttribute('class','emulator-trace');
    byId('emulator-trace').append(line);traces.push(line);if(traces.length>2500)traces.shift().remove();
  }else if(detail.position){position=detail.position;if(!frame)frame=requestAnimationFrame(drawPosition);}
}
function clearTrace(){traces.splice(0).forEach(line=>line.remove());}

const options={};
if(emulate){
  mountView();
  options.storageKey='plotui.emulator.machine';options.startupDelay=150;
  options.requestPort=async()=>{clearTrace();activePort=new EmulatorPort(receive);return activePort;};
  byId('emulator-panel').hidden=false;
  byId('emulator-clear').addEventListener('click',clearTrace);
  byId('emulator-hide').addEventListener('click',()=>{byId('emulator-panel').hidden=true;byId('emulator-show').hidden=false;});
  byId('emulator-show').addEventListener('click',()=>{byId('emulator-panel').hidden=false;byId('emulator-show').hidden=true;});
}
export const plotter=new Plotter(options);
