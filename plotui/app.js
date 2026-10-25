import {plotter} from './connection.js';
import {importSvg} from './svg.js';
import {buildPlotJob,mapMachineToEnvelope,mapMachineToPage,mapPointToMachine} from './gcode.js';
import {createHostOffer,acceptHostAnswer} from './live-link.js';
import {validateStrokeBatch} from './live-drawing.js';
import {drawQrCode,scanQrCode} from './qr-tools.js';
const debugMode=new URLSearchParams(location.search).get('debug')==='true'&&['localhost','127.0.0.1'].includes(location.hostname);
if(debugMode){const liveReload=new EventSource('/__plotui_live');liveReload.addEventListener('reload',()=>location.reload());}
const $=id=>document.getElementById(id),lines=[];
const terminalContent=$('terminal-content');
terminalContent.append(document.querySelector('.console-heading'),$('log'),$('message'),$('command-form'));
document.querySelectorAll('.workflow-step h3').forEach(heading=>{if(heading.textContent.trim()==='Serial transcript')heading.remove();});
const terminalPanel=$('terminal-panel');
const terminalToggle=$('terminal-toggle');
function setTerminalCollapsed(collapsed){terminalPanel.classList.toggle('collapsed',collapsed);terminalToggle.setAttribute('aria-expanded',String(!collapsed));terminalToggle.setAttribute('aria-label',collapsed?'Expand terminal':'Collapse terminal');}
setTerminalCollapsed(false);
terminalToggle.addEventListener('click',()=>setTerminalCollapsed(!terminalPanel.classList.contains('collapsed')));
export const message=text=>{$('message').textContent=text;};
plotter.addEventListener('log',({detail:{kind,text}})=>{const line=`${new Date().toLocaleTimeString()}  ${kind.toUpperCase().padEnd(6)} ${text}`;lines.push(line);if(lines.length>1000)lines.shift();const log=$('log');log.textContent=lines.join('\n');log.scrollTop=log.scrollHeight;});
let homingPendingCorner=null;
function renderMachine(machine=plotter.machine){
 const el=$('machine-status');if(!el)return;
 $('connection-step-state').textContent=plotter.connected?'Connected':'USB · GRBL';
 $('home-step-state').textContent=plotter.canMoveInsideEnvelope?'Locked':machine.homed?'Set opposite':'Required';
 const cornerNames={'top-left':'top left','top-right':'top right','bottom-left':'bottom left','bottom-right':'bottom right'};
 const opposite={'top-left':'bottom-right','top-right':'bottom-left','bottom-left':'top-right','bottom-right':'top-left'};
 if(plotter.canMoveInsideEnvelope)el.textContent=`Machine locked · ${machine.envelope.width.toFixed(1)} × ${machine.envelope.height.toFixed(1)} mm.`;
 else if(homingPendingCorner)el.textContent=`${cornerNames[homingPendingCorner]} selected. Move to ${opposite[homingPendingCorner].replace('-',' ')} and select that corner.`;
 else if(machine.homed&&machine.home&&machine.invalidated)el.textContent='Motion lock invalidated. Move to a corner and select it to start again.';
 else el.textContent=machine.envelope?'This connection needs homing. Move to any corner and select it.':'Move to any machine corner and select it.';
 const lockedCorners=plotter.canMoveInsideEnvelope?[machine.home?.corner,oppositeCorner(machine.home?.corner)]:[];
 const interactive=plotter.connected&&!plotter.busy&&!plotter.held&&!plotter.fault;
 document.querySelectorAll('[data-home-corner]').forEach(button=>{const c=button.dataset.homeCorner,selected=c===homingPendingCorner,locked=lockedCorners.includes(c),next=!!homingPendingCorner&&c===opposite[homingPendingCorner];button.disabled=!interactive||plotter.canMoveInsideEnvelope||!!homingPendingCorner&&!next;button.classList.toggle('selected',selected);button.classList.toggle('next-corner',next);button.classList.toggle('locked-corner',locked);button.setAttribute('aria-pressed',String(selected||locked));button.textContent=`${locked?'✓ ':''}${selected?'Home: ':locked?'':'Mark '}${cornerNames[c][0].toUpperCase()+cornerNames[c].slice(1)}`;});
 const page=machine.page,frame=page?.frame,captured=Object.keys(page?.corners||{}).length;
 $('page-step-state').textContent=frame?'Ready':`${captured}/3`;
 $('page-status').textContent=!plotter.canMoveInsideEnvelope?'Lock the machine envelope before recording page corners.':frame?`Page frame ready · ${frame.width.toFixed(1)} × ${frame.height.toFixed(1)} mm${frame.closureError===null?' · fourth-corner check optional':` · fourth-corner fit error ${frame.closureError.toFixed(2)} mm`}${frame.closureError!==null&&frame.closureError>3?' · recalibrate before plotting.':'.'}`:captured?`${captured} / 3 corners recorded. Mark ${3-captured} more.`:'Mark any three page corners with the pen nib.';
 $('page-status').classList.toggle('drawing-error',!!frame&&frame.closureError!==null&&frame.closureError>3);
 document.querySelectorAll('[data-page-corner]').forEach(button=>{const name=button.dataset.pageCorner,marked=!!page?.corners?.[name],checkCorner=frame?.checkCorner||(frame?'bottom-right':null),title=cornerNames[name][0].toUpperCase()+cornerNames[name].slice(1);button.disabled=!plotter.canMoveInsideEnvelope||!plotter.connected||plotter.busy||plotter.held||plotter.fault;button.textContent=frame&&name===checkCorner?`${marked?'✓ ':''}Check ${title}`:marked?`✓ ${title}`:`Mark ${title}`;});
 $('clear-page').disabled=!page||plotter.busy;
 const locked=plotter.motionLocked;
 $('motion-lock').textContent=locked?'🔒 Motion locked':machine.invalidated?'⚠ Motion lock invalidated':'🔓 Motion unlocked';
 $('motion-lock').classList.toggle('locked',locked);$('motion-lock').classList.toggle('invalidated',!!machine.invalidated);
 $('invalidate-lock').hidden=!locked;$('invalidate-lock').disabled=!plotter.connected||plotter.busy;
 renderMap(machine,cornerNames);
}
function renderMap(machine=plotter.machine,cornerNames={'top-left':'top left','top-right':'top right','bottom-left':'bottom left','bottom-right':'bottom right'}){
 const svg=$('machine-map'),readout=$('position-readout'),env=machine.envelope,home=machine.home;
 const p=plotter.position;
 readout.textContent=p?`MPos X ${p.x.toFixed(2)} · Y ${p.y.toFixed(2)} mm`:'—';
 if(!env||!home){svg.hidden=true;$('map-status').textContent='Record the machine envelope to see the head position.';return;}
 svg.hidden=false;
 const width=env.width,height=env.height,xSign=home.xSign??env.xSign??1,ySign=home.ySign??env.ySign??-1;
 const marginX=Math.max(12,width*.05),marginY=Math.max(16,height*.05);
 svg.setAttribute('viewBox',`${-marginX} ${-marginY} ${width+2*marginX} ${height+2*marginY}`);
 $('map-bed').setAttribute('width',width);$('map-bed').setAttribute('height',height);
 const homeX=xSign>0?0:width,homeY=ySign<0?0:height,farX=width-homeX,farY=height-homeY;
 const homeLabel=$('map-home-label'),farLabel=$('map-far-label');
 homeLabel.setAttribute('x',homeX+(homeX===0?2:-2));homeLabel.setAttribute('y',homeY===0?7:-2);homeLabel.setAttribute('text-anchor',homeX===0?'start':'end');
 farLabel.setAttribute('x',farX+(farX===0?2:-2));farLabel.setAttribute('y',farY===0?7:-2);farLabel.setAttribute('text-anchor',farX===0?'start':'end');
 homeLabel.textContent=`HOME · ${cornerNames[home.corner]||'saved corner'}`;farLabel.textContent=`${cornerNames[oppositeCorner(home.corner)]||'opposite'} · OPPOSITE`;
 const head=$('map-head');
 const pageFrame=machine.page?.frame,pagePoly=$('map-page');
 if(pageFrame){
  const toMap=point=>{const px=(point.x-home.x)*xSign,py=(point.y-home.y)*ySign;return`${(xSign>0?px:width-px).toFixed(3)},${(ySign<0?py:height-py).toFixed(3)}`;};
  pagePoly.setAttribute('points',[pageFrame.topLeft,pageFrame.topRight,pageFrame.bottomRight,{x:pageFrame.bottomLeft.x,y:pageFrame.bottomLeft.y}].map(toMap).join(' '));pagePoly.setAttribute('visibility','visible');
 }else pagePoly.setAttribute('visibility','hidden');
 if(!machine.homed||!p){head.setAttribute('visibility','hidden');$('map-status').textContent='Envelope saved; current home or head position is unknown.';return;}
 const x=(p.x-home.x)*xSign,y=(p.y-home.y)*ySign;
 const inside=x>=0&&x<=width&&y>=0&&y<=height;
 const mapX=xSign>0?x:width-x,mapY=ySign<0?y:height-y;
 head.setAttribute('transform',`translate(${Math.max(0,Math.min(width,mapX))} ${Math.max(0,Math.min(height,mapY))})`);head.setAttribute('visibility','visible');
 $('map-status').textContent=!plotter.connected?`Last reported position · ${x.toFixed(1)} mm from home, ${y.toFixed(1)} mm across · disconnected.`:machine.invalidated?'Motion lock invalidated · position shown for reference only.':inside?`Head position · ${x.toFixed(1)} mm from home, ${y.toFixed(1)} mm across · ${p.state}.`:`Head is outside the saved envelope · MPos X${p.x.toFixed(2)} Y${p.y.toFixed(2)}.`;
}
function oppositeCorner(corner){return {'top-left':'bottom-right','top-right':'bottom-left','bottom-left':'top-right','bottom-right':'top-left'}[corner]||'opposite corner';}
plotter.addEventListener('machine',e=>renderMachine(e.detail));
$('jog-step').onchange=()=>$('jog-step').blur();
async function selectHomeCorner(corner){
 if(!plotter.connected||plotter.busy||plotter.held||plotter.fault||plotter.canMoveInsideEnvelope)return;
 try{
  if(!homingPendingCorner){await plotter.markHome(corner);homingPendingCorner=corner;message(`Home set at ${corner.replace('-',' ')}. Move to the opposite corner.`);}
  else if(corner!==oppositeCorner(homingPendingCorner)){message(`Select the opposite corner: ${oppositeCorner(homingPendingCorner).replace('-',' ')}.`);return;}
  else{const envelope=await plotter.captureEnvelope();homingPendingCorner=null;message(`Machine locked · ${envelope.width.toFixed(1)} × ${envelope.height.toFixed(1)} mm.`);}
  renderMachine();
 }catch(error){message(error.message);}
}
document.querySelectorAll('[data-home-corner]').forEach(button=>button.addEventListener('click',()=>selectHomeCorner(button.dataset.homeCorner)));
$('invalidate-lock').onclick=()=>{if(confirm('Invalidate the recorded motion bounds?')){homingPendingCorner=null;plotter.invalidateLock();message('Motion lock invalidated.');}};
document.querySelectorAll('[data-page-corner]').forEach(button=>button.onclick=()=>plotter.markPageCorner(button.dataset.pageCorner).then(page=>message(page.frame?`Page frame recorded: ${page.frame.width.toFixed(1)} × ${page.frame.height.toFixed(1)} mm.`:`Page ${button.dataset.pageCorner.replace('-',' ')} recorded.`)).catch(e=>message(e.message)));
$('clear-page').onclick=()=>plotter.clearPageCalibration();
plotter.addEventListener('position',()=>renderMap());
let selectedSvg=null;
const svgInput=$('svg-file'),svgStatus=$('svg-status');
let drawingVersion=0,preparedDrawing=null,previewMode='machine',previewRotation=0,previewCenter={x:0,y:0},selectionBounds=null,dragState=null,drawingSelected=false,drawingImport=null;
const drawingInteraction=$('drawing-interaction'),drawingSelection=$('drawing-selection');
function drawingArea(){const m=plotter.machine;if(m.envelope&&m.homed&&!m.invalidated&&m.page?.frame)return{width:m.page.frame.width,height:m.page.frame.height,label:'Calibrated page'};if(m.envelope&&m.homed&&!m.invalidated)return{width:m.envelope.width,height:m.envelope.height,label:'Measured machine envelope'};return{width:210,height:297,label:'A4 preview (machine not homed)'};}
function envelopeToMachine(point,machine){
 const {home,envelope}=machine,xSign=home.xSign??envelope.xSign??1,ySign=home.ySign??envelope.ySign??-1;
 const x=xSign>0?point.x:envelope.width-point.x,y=ySign<0?point.y:envelope.height-point.y;
 return{x:home.x+x*xSign,y:home.y+y*ySign};
}
function previewGeometry(){
 const machine=plotter.machine,area=drawingArea(),envelope=machine.envelope,frame=plotter.canMoveInsideEnvelope?machine.page?.frame:null;
 if(frame&&previewMode==='machine')return{mode:'machine',width:envelope.width,height:envelope.height,area,machine,frame,viewBox:[-envelope.width*.025,-envelope.height*.025,envelope.width*1.05,envelope.height*1.05],bed:{x:0,y:0,width:envelope.width,height:envelope.height}};
 if(frame){
  const machineCorners=[{x:0,y:0},{x:envelope.width,y:0},{x:envelope.width,y:envelope.height},{x:0,y:envelope.height}].map(corner=>mapMachineToPage(envelopeToMachine(corner,machine),frame));
  const points=[{x:0,y:0},{x:frame.width,y:0},{x:frame.width,y:frame.height},{x:0,y:frame.height},...machineCorners];
  const minX=Math.min(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxX=Math.max(...points.map(p=>p.x)),maxY=Math.max(...points.map(p=>p.y)),mx=(maxX-minX)*.025,my=(maxY-minY)*.025;
  return{mode:'page',width:frame.width,height:frame.height,area,machine,frame,machineCorners,viewBox:[minX-mx,minY-my,maxX-minX+2*mx,maxY-minY+2*my],bed:{x:0,y:0,width:frame.width,height:frame.height}};
 }
 return{mode:'machine',width:area.width,height:area.height,area,machine,frame:null,viewBox:[0,0,area.width,area.height],bed:{x:0,y:0,width:area.width,height:area.height}};
}
function renderPreviewGeometry(geometry){
 const {width,height,area,machine,frame,mode,viewBox,bed:bedBounds,machineCorners}=geometry,preview=$('drawing-preview'),bed=$('drawing-bed'),page=$('drawing-page'),machineOutline=$('drawing-machine-outline');
 $('page-key').hidden=!frame;
 $('view-machine').setAttribute('aria-pressed',String(mode==='machine'));$('view-page').setAttribute('aria-pressed',String(mode==='page'));$('view-page').disabled=!frame;
 const [vx,vy,vw,vh]=viewBox,cx=vx+vw/2,cy=vy+vh/2,rotation=$('preview-rotation'),compass=$('plotter-compass-axes');previewCenter={x:cx,y:cy};
 if(previewRotation){preview.setAttribute('viewBox',[cx-vh/2,cy-vw/2,vh,vw].join(' '));rotation.setAttribute('transform',`translate(${cx+cy} ${cy-cx}) rotate(90)`);}
 else{preview.setAttribute('viewBox',viewBox.join(' '));rotation.removeAttribute('transform');}
 const rotateButton=$('preview-rotate');rotateButton.setAttribute('aria-pressed',String(!!previewRotation));rotateButton.setAttribute('aria-label',previewRotation?'Reset preview rotation':'Rotate preview 90 degrees clockwise');rotateButton.title=previewRotation?'Reset preview rotation':'Rotate preview 90° clockwise';rotateButton.textContent=previewRotation?'↶':'↻';compass.setAttribute('transform',`rotate(${previewRotation} 20 20)`);
 for(const [key,value] of Object.entries(bedBounds))bed.setAttribute(key,value);
 bed.classList.toggle('machine-bed',!!frame&&mode==='machine');bed.classList.toggle('page-bed',!!frame&&mode==='page');
 if(frame&&mode==='machine'){page.setAttribute('points',[frame.topLeft,frame.topRight,frame.bottomRight,frame.bottomLeft].map(point=>{const p=mapMachineToEnvelope(point,machine);return`${p.x.toFixed(3)},${p.y.toFixed(3)}`;}).join(' '));page.setAttribute('visibility','visible');}else page.setAttribute('visibility','hidden');
 if(frame&&mode==='page'){machineOutline.setAttribute('points',machineCorners.map(point=>`${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' '));machineOutline.setAttribute('visibility','visible');}else machineOutline.setAttribute('visibility','hidden');
 return frame?mode==='page'?`Page ${frame.width.toFixed(0)} × ${frame.height.toFixed(0)} mm · machine boundary shown`:`Machine ${width.toFixed(0)} × ${height.toFixed(0)} mm · page ${frame.width.toFixed(0)} × ${frame.height.toFixed(0)} mm`:area.label;
}
function updateDrawingSelection(bounds){
 drawingSelection.replaceChildren();selectionBounds=null;
 if(!bounds){drawingSelected=false;drawingSelection.classList.remove('selected');drawingSelection.setAttribute('visibility','hidden');return;}
 const {minX:x,minY:y}=bounds,width=bounds.maxX-x,height=bounds.maxY-y;
 if(!Number.isFinite(width+height)){drawingSelection.setAttribute('visibility','hidden');return;}
 selectionBounds={x,y,width,height};drawingSelection.setAttribute('visibility','visible');drawingSelection.classList.toggle('selected',drawingSelected);
 const outline=document.createElementNS('http://www.w3.org/2000/svg','rect');outline.setAttribute('x',x);outline.setAttribute('y',y);outline.setAttribute('width',width);outline.setAttribute('height',height);outline.setAttribute('class','drawing-selection-outline');outline.dataset.drag='move';outline.setAttribute('aria-label','Drag to move drawing');drawingSelection.append(outline);
 for(const corner of ['nw','ne','sw','se']){const hx=corner.includes('e')?x+width:x,hy=corner.includes('s')?y+height:y,handle=document.createElementNS('http://www.w3.org/2000/svg','rect');handle.setAttribute('x',hx-1.25);handle.setAttribute('y',hy-1.25);handle.setAttribute('width',2.5);handle.setAttribute('height',2.5);handle.setAttribute('class','drawing-scale-handle');handle.dataset.resize=corner;handle.setAttribute('aria-label',`Drag ${corner} corner to resize proportionally`);drawingSelection.append(handle);}
}
async function renderDrawing(){
 const version=++drawingVersion;drawingImport?.abort();const controller=new AbortController();drawingImport=controller;const area=drawingArea(),geometry=previewGeometry(),preview=$('drawing-preview'),pathsGroup=$('drawing-paths');
 const geometryLabel=renderPreviewGeometry(geometry);
 if(!selectedSvg){drawingImport=null;preparedDrawing=null;drawingInteraction.removeAttribute('transform');pathsGroup.replaceChildren();updateDrawingSelection(null);$('drawing-status').textContent=geometry.frame?`${geometryLabel} · green outline marks the calibrated page`:`${geometryLabel} · import an SVG to preview`;preview.classList.remove('out-of-bounds');$('drawing-metrics').textContent='';$('drawing-warnings').textContent='';return;}
 preparedDrawing=null;updatePlotControls();
 const options={targetWidth:area.width,targetHeight:area.height,margin:8,curveTolerance:Number($('curve-tolerance').value),simplifyTolerance:Number($('simplify-tolerance').value),sort:$('sort-paths').checked,scalePercent:Number($('drawing-scale').value),offsetX:Number($('drawing-offset-x').value),offsetY:Number($('drawing-offset-y').value),signal:controller.signal,onProgress:(phase,done,total)=>{if(version===drawingVersion)$('drawing-status').textContent=`${phase}${total>1?` · ${Math.floor(done)}/${Math.floor(total)}`:''} · ${area.width.toFixed(0)} × ${area.height.toFixed(0)} mm`;}};
 if(!Number.isFinite(options.curveTolerance)||options.curveTolerance<=0||!Number.isFinite(options.simplifyTolerance)||options.simplifyTolerance<0||!Number.isFinite(options.scalePercent)||options.scalePercent<=0||!Number.isFinite(options.offsetX)||!Number.isFinite(options.offsetY)){$('drawing-status').textContent='Enter positive tolerances and a valid scale or offset.';return;}
 $('drawing-status').textContent=`Calculating paths · ${area.width.toFixed(0)} × ${area.height.toFixed(0)} mm`;
 try{
  const result=await importSvg(selectedSvg,options);if(version!==drawingVersion)return;drawingImport=null;preparedDrawing=result;$('drawing-step-state').textContent=`${result.paths.length} paths`;
  let displayBounds=null;const drawingParts=[];for(const path of result.paths){const points=geometry.frame&&geometry.mode==='machine'?path.points.map(point=>mapMachineToEnvelope(mapPointToMachine(point,geometry.machine),geometry.machine)):path.points;for(const p of points){if(!displayBounds)displayBounds={minX:p.x,minY:p.y,maxX:p.x,maxY:p.y};else{displayBounds.minX=Math.min(displayBounds.minX,p.x);displayBounds.minY=Math.min(displayBounds.minY,p.y);displayBounds.maxX=Math.max(displayBounds.maxX,p.x);displayBounds.maxY=Math.max(displayBounds.maxY,p.y);}}let d=points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ');if(path.closed)d+=' Z';drawingParts.push(d);}if(drawingParts.length){const el=document.createElementNS('http://www.w3.org/2000/svg','path');el.setAttribute('d',drawingParts.join(' '));el.setAttribute('class','drawing-line');pathsGroup.replaceChildren(el);}else pathsGroup.replaceChildren();updateDrawingSelection(displayBounds);drawingInteraction.removeAttribute('transform');
  const b=result.bounds,w=b?b.maxX-b.minX:0,h=b?b.maxY-b.minY:0;
  $('drawing-status').textContent=`${selectedSvg.name} · ${result.paths.length} paths · ${geometryLabel}${result.outOfBounds?' · OUTSIDE BOUNDS':''}`;
  $('drawing-status').classList.toggle('drawing-error',result.outOfBounds);$('drawing-preview').classList.toggle('out-of-bounds',result.outOfBounds);
  $('drawing-metrics').textContent=`${w.toFixed(1)} × ${h.toFixed(1)} mm · draw ${result.drawLength.toFixed(0)} mm · pen-up from origin ${result.penUpLength.toFixed(0)} mm · ${result.segmentCount} segments`;
  const pageFit=plotter.machine.page?.frame?.closureError;
  $('drawing-warnings').textContent=result.warnings.join(' ')+(result.outOfBounds?' Drawing extends beyond the area; reduce scale or adjust offsets.':'')+(pageFit>3?` Page corners disagree by ${pageFit.toFixed(1)} mm; recalibrate before plotting.`:'');updatePlotControls();
 }catch(error){if(version!==drawingVersion)return;drawingImport=null;preparedDrawing=null;drawingInteraction.removeAttribute('transform');$('drawing-status').textContent=error.message;$('drawing-status').classList.add('drawing-error');preview.classList.remove('out-of-bounds');$('drawing-metrics').textContent='';$('drawing-warnings').textContent='';pathsGroup.replaceChildren();updateDrawingSelection(null);}
}
function svgPoint(event){const svg=$('drawing-preview'),point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;const p=point.matrixTransform(svg.getScreenCTM().inverse());if(!previewRotation)return p;const {x:cx,y:cy}=previewCenter;return{x:p.y-cy+cx,y:cx+cy-p.x};}
function areaToPreview(point,geometry){return geometry.frame&&geometry.mode==='machine'?mapMachineToEnvelope(mapPointToMachine(point,geometry.machine),geometry.machine):point;}
function previewToArea(point,geometry){
 const origin=areaToPreview({x:0,y:0},geometry),unitX=areaToPreview({x:1,y:0},geometry),unitY=areaToPreview({x:0,y:1},geometry),ax=unitX.x-origin.x,ay=unitX.y-origin.y,bx=unitY.x-origin.x,by=unitY.y-origin.y,det=ax*by-ay*bx,dx=point.x-origin.x,dy=point.y-origin.y;
 if(Math.abs(det)<1e-12)throw Error('The preview transform is degenerate.');
 return{x:(dx*by-dy*bx)/det,y:(ax*dy-ay*dx)/det};
}
function resizeRatio(state,current){const startDistance=Math.hypot(state.start.x-state.fixed.x,state.start.y-state.fixed.y);return Math.max(0.01,Math.hypot(current.x-state.fixed.x,current.y-state.fixed.y)/Math.max(startDistance,1e-9));}
function beginDrawingDrag(event){
 const resize=event.target.closest('[data-resize]'),move=event.target.closest('[data-drag]');
 if(!resize&&!move){if(drawingSelected){drawingSelected=false;drawingSelection.classList.remove('selected');}return;}
 if(!preparedDrawing)return;drawingSelected=true;drawingSelection.classList.add('selected');
 event.preventDefault();const start=svgPoint(event),b=selectionBounds,corner=resize?.dataset.resize;
 const fixed=corner?{x:corner.includes('e')?b.x:b.x+b.width,y:corner.includes('s')?b.y:b.y+b.height}:null;
 dragState={pointerId:event.pointerId,mode:resize?'resize':'move',corner,start,fixed,scale:Number($('drawing-scale').value),offsetX:Number($('drawing-offset-x').value),offsetY:Number($('drawing-offset-y').value),geometry:previewGeometry(),moved:false};
 $('drawing-preview').setPointerCapture(event.pointerId);$('drawing-preview').classList.add('is-transforming');
}
function moveDrawingDrag(event){
 const state=dragState;if(!state||event.pointerId!==state.pointerId)return;const current=svgPoint(event);
 if(Math.hypot(current.x-state.start.x,current.y-state.start.y)>0.15)state.moved=true;
 if(state.mode==='move')drawingInteraction.setAttribute('transform',`translate(${current.x-state.start.x} ${current.y-state.start.y})`);
 else{const ratio=resizeRatio(state,current),f=state.fixed;drawingInteraction.setAttribute('transform',`translate(${f.x} ${f.y}) scale(${ratio}) translate(${-f.x} ${-f.y})`);}
}
function endDrawingDrag(event,cancelled=false){
 const state=dragState;if(!state||event.pointerId!==state.pointerId)return;dragState=null;const current=svgPoint(event),geometry=state.geometry;
 $('drawing-preview').classList.remove('is-transforming');
 if(cancelled||!state.moved){drawingInteraction.removeAttribute('transform');return;}
 if(state.mode==='move'){
  const from=previewToArea(state.start,geometry),to=previewToArea(current,geometry);
  $('drawing-offset-x').value=(state.offsetX+to.x-from.x).toFixed(2);$('drawing-offset-y').value=(state.offsetY+to.y-from.y).toFixed(2);
 }else{
  const ratio=resizeRatio(state,current),oldScale=state.scale,newScale=Math.max(10,Math.min(300,oldScale*ratio)),anchor=previewToArea(state.fixed,geometry),area=geometry.area,k=newScale/oldScale;
  $('drawing-scale').value=newScale.toFixed(2);
  $('drawing-offset-x').value=(anchor.x-area.width/2-k*(anchor.x-area.width/2-state.offsetX)).toFixed(2);
  $('drawing-offset-y').value=(anchor.y-area.height/2-k*(anchor.y-area.height/2-state.offsetY)).toFixed(2);
 }
 renderDrawing();
}
$('drawing-preview').addEventListener('pointerdown',beginDrawingDrag);
$('drawing-preview').addEventListener('pointermove',moveDrawingDrag);
$('drawing-preview').addEventListener('pointerup',event=>endDrawingDrag(event));
$('drawing-preview').addEventListener('pointercancel',event=>endDrawingDrag(event,true));
document.addEventListener('pointerdown',event=>{if(drawingSelected&&!$('drawing-preview').contains(event.target)){drawingSelected=false;drawingSelection.classList.remove('selected');}});
$('view-machine').onclick=()=>{previewMode='machine';renderDrawing();};
$('view-page').onclick=()=>{if(!plotter.machine.page?.frame)return;previewMode='page';renderDrawing();};
$('preview-rotate').onclick=()=>{previewRotation=previewRotation?0:90;renderPreviewGeometry(previewGeometry());};
function updatePreviewPen(){
 const color=$('preview-pen-color').value,width=$('preview-pen-width').valueAsNumber;
 if(CSS.supports('color',color))$('drawing-preview').style.setProperty('--preview-pen-color',color);
 if(Number.isFinite(width)&&width>=0.05&&width<=3)$('drawing-preview').style.setProperty('--preview-pen-width',String(width));
}
$('preview-pen-color').addEventListener('input',updatePreviewPen);
$('preview-pen-width').addEventListener('input',updatePreviewPen);
updatePreviewPen();
svgInput.onchange=async()=>{
 drawingSelected=false;drawingSelection.classList.remove('selected');selectedSvg=null;const file=svgInput.files?.[0];if(!file){$('drawing-step-state').textContent='Choose SVG';svgStatus.textContent='';renderDrawing();return;}
 if(file.size>5*1024*1024){svgInput.value='';svgStatus.textContent='SVG files must be 5 MB or smaller.';renderDrawing();return;}
 selectedSvg=file;$('svg-options').hidden=false;svgStatus.textContent=`${file.name} · ${(file.size/1024).toFixed(1)} KB`;$('drawing-step-state').textContent='Preparing';await renderDrawing();
};
$('rebuild-svg').onclick=()=>renderDrawing();
['curve-tolerance','simplify-tolerance','sort-paths','drawing-scale','drawing-offset-x','drawing-offset-y'].forEach(id=>$(id).addEventListener('change',renderDrawing));
plotter.addEventListener('machine',()=>renderDrawing());
const plotOptionIds=['plot-pen-up','plot-pen-down','plot-pen-up-delay','plot-pen-down-delay','plot-draw-feed','plot-travel-mode','plot-travel-feed'];
function plotOptions(){return{penUp:$('plot-pen-up').value,penDown:$('plot-pen-down').value,penUpDelay:$('plot-pen-up-delay').value,penDownDelay:$('plot-pen-down-delay').value,drawFeed:$('plot-draw-feed').value,travelMode:$('plot-travel-mode').value,travelFeed:$('plot-travel-feed').value};}
function updatePlotControls(){
 const button=$('plot-drawing'),startButton=$('go-drawing-start'),status=$('plot-progress'),machine=plotter.machine,env=machine.envelope;
 let commands=null,error='';
 try{if(preparedDrawing)commands=buildPlotJob(preparedDrawing.paths,machine,plotOptions());}catch(e){error=e.message;}
 const firstPath=preparedDrawing?.paths?.find(path=>Array.isArray(path.points)&&path.points.length>=2);
 const activeArea=drawingArea(),sameArea=!!env&&plotter.canMoveInsideEnvelope&&preparedDrawing?.targetWidth===activeArea.width&&preparedDrawing?.targetHeight===activeArea.height;
 const ready=!!commands&&sameArea&&!preparedDrawing.outOfBounds&&plotter.canMoveInsideEnvelope&&!!machine.page?.frame&&plotter.connected&&!plotter.busy&&!plotter.held&&!plotter.fault&&plotter.position?.state==='Idle';
 $('plot-step-state').textContent=ready?'Ready':plotter.busy?'Working':preparedDrawing?'Check setup':'Waiting';
 button.disabled=!ready;
 startButton.disabled=!ready||!firstPath;
 if(plotter.busy&&plotJobRunning)status.textContent=plotProgressText;
 else if(error)status.textContent=error;
 else if(!preparedDrawing)status.textContent='Import an SVG and prepare its paths first.';
 else if(!plotter.canMoveInsideEnvelope)status.textContent='Plotting requires a valid motion lock and measured envelope.';
 else if(!machine.page?.frame)status.textContent='Record page top-left, top-right, and bottom-left before plotting.';
 else if(!sameArea)status.textContent='Rebuilding preview for the current calibrated area…';
 else if(preparedDrawing.outOfBounds)status.textContent='Drawing extends outside the machine area. Adjust scale or placement.';
 else if(!plotter.connected)status.textContent=`${commands.length} G-code commands ready. Connect the plotter to continue.`;
 else if(plotter.position?.state!=='Idle')status.textContent=`${commands.length} G-code commands ready. Waiting for GRBL to report Idle.`;
 else status.textContent=`${commands.length} G-code commands ready. Review the preview and settings before plotting.`;
}
let plotJobRunning=false,plotProgressText='',manualPenDown=false,liveActiveBatch=null;
const plotProgressBar=$('plot-progress-bar');
function setPlotProgress(sent,total,visible=true){plotProgressBar.max=Math.max(1,total);plotProgressBar.value=Math.max(0,Math.min(sent,total));plotProgressBar.hidden=!visible;plotProgressBar.setAttribute('aria-valuetext',`${Math.round(100*plotProgressBar.value/plotProgressBar.max)} percent`);}
plotOptionIds.forEach(id=>$(id).addEventListener('input',updatePlotControls));
plotter.addEventListener('state',updatePlotControls);plotter.addEventListener('position',updatePlotControls);
plotter.addEventListener('plot-progress',e=>{plotProgressText=`Sending G-code · ${e.detail.sent} / ${e.detail.total} commands acknowledged.`;$('plot-progress').textContent=plotProgressText;setPlotProgress(e.detail.sent,e.detail.total,plotJobRunning||!!liveActiveBatch);if(liveActiveBatch)sendLive({type:'batch-status',id:liveActiveBatch.id,status:'plotting',progress:{sent:e.detail.sent,total:e.detail.total}});});
$('go-drawing-start').onclick=async()=>{
 try{
  const path=preparedDrawing?.paths?.find(item=>Array.isArray(item.points)&&item.points.length>=2);
  if(!path||!plotter.canMoveInsideEnvelope||!plotter.machine.page?.frame||!plotter.connected||plotter.position?.state!=='Idle'||preparedDrawing.outOfBounds)throw Error('Move is not ready: prepare the drawing, calibrate the page, then check the motion lock, connection, and GRBL Idle state.');
  const target=mapPointToMachine(path.points[0],plotter.machine);
  await plotter.goToPoint(target);message('Moved to the start of the prepared drawing with the pen raised.');
 }catch(e){message(e.message);}
};
$('plot-drawing').onclick=async()=>{
 try{
  const commands=buildPlotJob(preparedDrawing?.paths,plotter.machine,plotOptions());
  if(!plotter.canMoveInsideEnvelope||!plotter.machine.page?.frame||!plotter.connected||plotter.position?.state!=='Idle'||preparedDrawing.outOfBounds)throw Error('Plotting is not ready: calibrate the page, then check the motion lock, machine area, connection, and GRBL Idle state.');
  if(!confirm(`Send ${commands.length} G-code commands for ${preparedDrawing.paths.length} paths? The plotter will move within the measured envelope. Keep hands clear.`))return;
  plotJobRunning=true;manualPenDown=false;plotProgressText=`Sending G-code · 0 / ${commands.length} commands acknowledged.`;setPlotProgress(0,commands.length);updatePlotControls();
  const sent=await plotter.plot(commands);message(`Plot complete · ${sent} commands acknowledged; GRBL is Idle.`);
 }catch(e){message(e.message);$('plot-progress').textContent=e.message;}
 finally{plotJobRunning=false;manualPenDown=false;plotProgressBar.hidden=true;updatePlotControls();}
};
let positionTimer=null,positionPollRunning=false;
async function pollPosition(){if(!plotter.connected||plotter.busy||plotter.pending||positionPollRunning)return;positionPollRunning=true;try{await plotter.getPosition(1200,true);}catch{}finally{positionPollRunning=false;}}
plotter.addEventListener('state',()=>{const on=plotter.connected;if(!on)manualPenDown=false;$('status').textContent=on?(plotter.fault?'Reconnect required':plotter.held?'Feed held':'Connected'):'Disconnected';$('connect').disabled=!!plotter.port||!plotter.available;$('disconnect').disabled=!plotter.port;$('baud').disabled=!!plotter.port;renderMachine();document.querySelectorAll('[data-command],#send,#reset,[data-jog],[data-pen]').forEach(b=>{const resume=b.dataset.command==='~',hold=b.dataset.command==='!';b.disabled=!on||plotter.fault||(!hold&&plotter.busy)||(resume?!plotter.held:plotter.held);});$('hold').disabled=!on||plotter.fault;if(on&&!positionTimer){pollPosition();positionTimer=setInterval(pollPosition,500);}else if(!on&&positionTimer){clearInterval(positionTimer);positionTimer=null;}updatePlotControls();});
async function send(command){try{const result=await plotter.command(command);const servo=command.trim().match(/^M3\s+S([-+\d.eE]+)$/i);if(servo)manualPenDown=Number(servo[1])>=40;message(result.at(-1)==='ok'?'Acknowledged (movement may still be running).':result.join('\n'));return result;}catch(e){message(e.message);throw e;}}
async function setPenPosition(down){
 const value=Number($(down?'plot-pen-down':'plot-pen-up').value),delay=Number($(down?'plot-pen-down-delay':'plot-pen-up-delay').value);
 if(!Number.isInteger(value)||value<0||value>1000||!Number.isFinite(delay)||delay<0||delay>30){message('Enter a valid pen position and delay in Plot settings.');return;}
 try{await send(`M3 S${value}`);await send(`G4 P${delay}`);message(`Pen ${down?'down':'up'}.`);}catch{}
}
$('remote-pen-up').onclick=()=>setPenPosition(false);
$('remote-pen-down').onclick=()=>setPenPosition(true);
$('connect').onclick=async()=>{try{$('connect').disabled=true;await plotter.connect(Number($('baud').value));message('Connected. Use Status or Firmware to inspect the controller.');}catch(e){message(e.message);await plotter.disconnect();$('connect').disabled=!plotter.available;}};
$('disconnect').onclick=()=>plotter.disconnect().catch(e=>message(e.message));
document.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>send(b.dataset.command).catch(()=>{}));
function jogDirection(axis,sign){const step=Number($('jog-step').value)*sign,feed=Number($('plot-draw-feed').value);plotter.jog(axis,step,{penDown:manualPenDown,feed}).catch(e=>message(e.message));}
document.querySelectorAll('[data-jog]').forEach(b=>b.onclick=()=>jogDirection(b.getAttribute('aria-axis'),Number(b.getAttribute('aria-sign'))));
window.addEventListener('keydown',e=>{
 if(e.altKey||e.ctrlKey||e.metaKey||e.repeat||e.target instanceof Element&&e.target.matches('input,textarea,select,[contenteditable="true"]'))return;
 const keys={ArrowLeft:['X',-1],ArrowRight:['X',1],ArrowUp:['Y',1],ArrowDown:['Y',-1]};
 const move=keys[e.key];if(!move||!plotter.connected)return;
 e.preventDefault();jogDirection(...move);
});
$('hold').onclick=()=>send('!').catch(()=>{});
$('reset').onclick=()=>{if(confirm('Soft-reset GRBL? This aborts motion and may invalidate the position.')){window.dispatchEvent(new Event('plotui-disarm'));send('\x18').catch(()=>{});}};
$('command-form').onsubmit=e=>{e.preventDefault();send($('command').value).catch(()=>{});};
$('download').onclick=()=>{const url=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download='plotui-serial.log';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
let liveLink=null,liveCalibration=null,liveAnswerApplied=false,liveAssembler=null,liveExpectedSequence=1,liveQueue=[],liveRunning=false,liveCreating=false;
function getLiveCalibration(){
 const machine=plotter.machine,frame=machine.page?.frame;
 if(!plotter.connected||!plotter.canMoveInsideEnvelope||!frame||frame.closureError!==null&&frame.closureError>3)return null;
 const key=JSON.stringify({home:machine.home,envelope:machine.envelope,frame});
 return{width:frame.width,height:frame.height,key};
}
function liveBlockReason(){
 const machine=plotter.machine,frame=machine.page?.frame;
 if(!plotter.connected)return'Connect the plotter first.';
 if(plotter.fault)return'Reconnect the plotter to clear its serial fault.';
 if(!plotter.canMoveInsideEnvelope)return'Lock the machine envelope before pairing.';
 if(!frame)return'Calibrate the page before pairing.';
 if(frame.closureError!==null&&frame.closureError>3)return`Page fit error ${frame.closureError.toFixed(1)} mm · recalibrate before plotting.`;
 if(plotter.busy)return'Wait for the plotter to become idle.';
 return'';
}
function updateLivePanel(){
 const calibrated=getLiveCalibration(),open=!!liveLink?.isOpen();
 const reason=liveBlockReason();$('live-create').disabled=!!reason||liveCreating;
 $('live-accept').disabled=!liveLink||liveAnswerApplied||plotter.busy;
 $('live-close').disabled=!liveLink;
 $('live-step-state').textContent=open?'Connected':liveLink?'Pairing':'Disconnected';
 if(reason&&!liveQueue.length)$('live-status').textContent=reason;
 else if(liveLink&&liveCalibration&&calibrated?.key!==liveCalibration.key)$('live-status').textContent='Calibration changed · disconnect and pair again.';
 else if(calibrated&&!liveLink)$('live-status').textContent=`Page ready · ${calibrated.width.toFixed(1)} × ${calibrated.height.toFixed(1)} mm.`;
 $('live-queue').textContent=liveQueue.length?`${liveQueue.length} batch${liveQueue.length===1?'':'es'} waiting to plot.`:'';
}
function sendLive(message){return !!liveLink?.send('reliable',JSON.stringify(message));}
function liveError(message){sendLive({type:'error',message});}
function handleLiveMessage(channel,data){
 if(channel!=='reliable')return;let message;try{message=JSON.parse(data);}catch{return;}
 if(message.type==='batch-start'){
  if(liveAssembler){liveError('A previous drawing batch is incomplete.');return;}
  const calibration=getLiveCalibration();
  if(!calibration||calibration.key!==liveCalibration?.key){liveError('Plotter page calibration changed. Pair again after calibration.');return;}
  if(message.seq!==liveExpectedSequence||typeof message.id!=='string'||message.id.length>100||message.width!==calibration.width||message.height!==calibration.height||!Number.isInteger(message.strokeCount)||message.strokeCount<1||message.strokeCount>5000){liveError('Drawing batch metadata is invalid.');return;}
  liveAssembler={id:message.id,seq:message.seq,strokes:Array.from({length:message.strokeCount},()=>[]),pointCount:0};return;
 }
 if(message.type==='batch-points'){
  const batch=liveAssembler;if(!batch||message.id!==batch.id||!Number.isInteger(message.stroke)||!Number.isInteger(message.offset)||!Array.isArray(message.points)||message.points.length<1||message.points.length>400){liveError('Drawing data is incomplete or invalid.');liveAssembler=null;return;}
  const stroke=batch.strokes[message.stroke];if(!stroke||message.offset!==stroke.length||batch.pointCount+message.points.length>200000){liveError('Drawing data is out of order or too large.');liveAssembler=null;return;}
  for(const point of message.points){if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y)){liveError('Drawing contains invalid coordinates.');liveAssembler=null;return;}stroke.push({x:point.x,y:point.y});}
  batch.pointCount+=message.points.length;return;
 }
 if(message.type==='batch-end'){
  const batch=liveAssembler;liveAssembler=null;
  if(!batch||message.id!==batch.id||message.seq!==batch.seq){liveError('Drawing batch was incomplete.');return;}
  try{validateStrokeBatch(batch.strokes,liveCalibration.width,liveCalibration.height);}catch(error){liveError(error.message);return;}
  liveQueue.push({...batch,calibrationKey:liveCalibration.key});liveExpectedSequence++;
  sendLive({type:'batch-status',id:batch.id,status:'queued'});updateLivePanel();runLiveQueue();
 }
}
async function runLiveQueue(){
 if(liveRunning||plotter.busy||!liveQueue.length)return;liveRunning=true;
 try{
  while(liveQueue.length){const batch=liveQueue.shift();liveActiveBatch=batch;updateLivePanel();
   try{
    const calibration=getLiveCalibration();if(!calibration||calibration.key!==batch.calibrationKey||batch.calibrationKey!==liveCalibration?.key)throw Error('Page calibration changed. Reconnect and recalibrate before plotting.');
    if(!plotter.connected||!plotter.canMoveInsideEnvelope)throw Error('The plotter is not connected and homed.');
    const commands=buildPlotJob(batch.strokes.map(points=>({points,closed:false})),plotter.machine,plotOptions());
    sendLive({type:'batch-status',id:batch.id,status:'plotting'});await plotter.plot(commands);
    sendLive({type:'batch-status',id:batch.id,status:'complete'});
   }catch(error){sendLive({type:'batch-status',id:batch.id,status:'failed',message:error.message});for(const queued of liveQueue.splice(0))sendLive({type:'batch-status',id:queued.id,status:'failed',message:'Earlier batch failed; check the plotter before sending more.'});break;}
   finally{liveActiveBatch=null;}
  }
 }finally{liveRunning=false;if(!plotJobRunning)plotProgressBar.hidden=true;updateLivePanel();if(liveQueue.length&&!plotter.busy)setTimeout(runLiveQueue,0);}
}
const hostLinkEvents={
 onState:state=>{if(/failed|closed|disconnected/i.test(state))$('live-status').textContent=`Connection ${state}.`;updateLivePanel();},
 onOpen:()=>{const calibration=getLiveCalibration();if(!calibration||calibration.key!==liveCalibration?.key){$('live-status').textContent='Page calibration changed. Create a new invitation.';return;}$('live-offer-qr').hidden=true;sendLive({type:'hello',version:1,width:calibration.width,height:calibration.height});$('live-status').textContent=`Connected · page ${calibration.width.toFixed(1)} × ${calibration.height.toFixed(1)} mm.`;updateLivePanel();},
 onMessage:handleLiveMessage,
};
$('live-create').onclick=async()=>{
 const calibration=getLiveCalibration();if(!calibration)return;
 liveCreating=true;liveLink?.close();liveLink=null;liveCalibration=calibration;liveAssembler=null;liveExpectedSequence=1;liveAnswerApplied=false;
 $('live-offer-qr').hidden=true;$('live-accept').disabled=true;$('live-status').textContent='Creating invitation QR…';updateLivePanel();
 try{const result=await createHostOffer(hostLinkEvents);liveLink=result.link;const inviteUrl=new URL('./companion.html',location.href);inviteUrl.hash=`join=${encodeURIComponent(result.code)}`;drawQrCode($('live-offer-qr'),inviteUrl.href,300);$('live-offer-qr').hidden=false;$('live-status').textContent='Scan with the other device to open Live drawing and pair.';updateLivePanel();}
 catch(error){$('live-status').textContent=error.message;liveLink=null;updateLivePanel();}
 finally{liveCreating=false;updateLivePanel();}
};
$('live-accept').onclick=async()=>{try{const code=await scanQrCode(text=>/^mgl1[zr]\./.test(text.trim()),'Scan the reply QR code');if(!code)return;await acceptHostAnswer(liveLink,code);liveAnswerApplied=true;$('live-status').textContent='Connecting…';updateLivePanel();}catch(error){$('live-status').textContent=error.message;}};
$('live-close').onclick=()=>{liveLink?.close();liveLink=null;liveCalibration=null;liveAssembler=null;liveAnswerApplied=false;$('live-offer-qr').hidden=true;updateLivePanel();};
plotter.addEventListener('machine',updateLivePanel);plotter.addEventListener('state',()=>{updateLivePanel();if(!plotter.busy)runLiveQueue();});
updateLivePanel();
renderMachine();
if(!plotter.available){$('connect').disabled=true;message('Web Serial is unavailable. Open this page in Chrome using localhost or HTTPS.');}
plotter.state();
