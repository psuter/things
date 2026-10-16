import {plotter} from './connection.js';
import {importSvg} from './svg.js';
import {buildPlotJob,mapMachineToEnvelope,mapMachineToPage,mapPointToMachine} from './gcode.js';
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
let drawingVersion=0,preparedDrawing=null,previewMode='machine';
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
 preview.setAttribute('viewBox',viewBox.join(' '));
 for(const [key,value] of Object.entries(bedBounds))bed.setAttribute(key,value);
 bed.classList.toggle('machine-bed',!!frame&&mode==='machine');bed.classList.toggle('page-bed',!!frame&&mode==='page');
 if(frame&&mode==='machine'){page.setAttribute('points',[frame.topLeft,frame.topRight,frame.bottomRight,frame.bottomLeft].map(point=>{const p=mapMachineToEnvelope(point,machine);return`${p.x.toFixed(3)},${p.y.toFixed(3)}`;}).join(' '));page.setAttribute('visibility','visible');}else page.setAttribute('visibility','hidden');
 if(frame&&mode==='page'){machineOutline.setAttribute('points',machineCorners.map(point=>`${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' '));machineOutline.setAttribute('visibility','visible');}else machineOutline.setAttribute('visibility','hidden');
 return frame?mode==='page'?`Page ${frame.width.toFixed(0)} × ${frame.height.toFixed(0)} mm · machine boundary shown`:`Machine ${width.toFixed(0)} × ${height.toFixed(0)} mm · page ${frame.width.toFixed(0)} × ${frame.height.toFixed(0)} mm`:area.label;
}
async function renderDrawing(){
 const version=++drawingVersion,area=drawingArea(),geometry=previewGeometry(),preview=$('drawing-preview'),pathsGroup=$('drawing-paths');
 const geometryLabel=renderPreviewGeometry(geometry);
 if(!selectedSvg){preparedDrawing=null;pathsGroup.replaceChildren();$('drawing-status').textContent=geometry.frame?`${geometryLabel} · green outline marks the calibrated page`:`${geometryLabel} · import an SVG to preview`;preview.classList.remove('out-of-bounds');$('drawing-metrics').textContent='';$('drawing-warnings').textContent='';return;}
 const options={targetWidth:area.width,targetHeight:area.height,margin:8,curveTolerance:Number($('curve-tolerance').value),simplifyTolerance:Number($('simplify-tolerance').value),sort:$('sort-paths').checked,scalePercent:Number($('drawing-scale').value),offsetX:Number($('drawing-offset-x').value),offsetY:Number($('drawing-offset-y').value)};
 if(!Number.isFinite(options.curveTolerance)||options.curveTolerance<=0||!Number.isFinite(options.simplifyTolerance)||options.simplifyTolerance<0||!Number.isFinite(options.scalePercent)||options.scalePercent<=0||!Number.isFinite(options.offsetX)||!Number.isFinite(options.offsetY)){$('drawing-status').textContent='Enter positive tolerances and a valid scale or offset.';return;}
 $('drawing-status').textContent=`Calculating paths · ${area.width.toFixed(0)} × ${area.height.toFixed(0)} mm`;pathsGroup.replaceChildren();
 try{
  const result=await importSvg(selectedSvg,options);if(version!==drawingVersion)return;preparedDrawing=result;$('drawing-step-state').textContent=`${result.paths.length} paths`;
  const frag=document.createDocumentFragment();for(const path of result.paths){const points=geometry.frame&&geometry.mode==='machine'?path.points.map(point=>mapMachineToEnvelope(mapPointToMachine(point,geometry.machine),geometry.machine)):path.points;let d=points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ');if(path.closed)d+=' Z';const el=document.createElementNS('http://www.w3.org/2000/svg','path');el.setAttribute('d',d);el.setAttribute('class','drawing-line');frag.append(el);}pathsGroup.replaceChildren(frag);
  const b=result.bounds,w=b?b.maxX-b.minX:0,h=b?b.maxY-b.minY:0;
  $('drawing-status').textContent=`${selectedSvg.name} · ${result.paths.length} paths · ${geometryLabel}${result.outOfBounds?' · OUTSIDE BOUNDS':''}`;
  $('drawing-status').classList.toggle('drawing-error',result.outOfBounds);$('drawing-preview').classList.toggle('out-of-bounds',result.outOfBounds);
  $('drawing-metrics').textContent=`${w.toFixed(1)} × ${h.toFixed(1)} mm · draw ${result.drawLength.toFixed(0)} mm · pen-up from origin ${result.penUpLength.toFixed(0)} mm · ${result.segmentCount} segments`;
  const pageFit=plotter.machine.page?.frame?.closureError;
  $('drawing-warnings').textContent=result.warnings.join(' ')+(result.outOfBounds?' Drawing extends beyond the area; reduce scale or adjust offsets.':'')+(pageFit>3?` Page corners disagree by ${pageFit.toFixed(1)} mm; recalibrate before plotting.`:'');updatePlotControls();
 }catch(error){if(version!==drawingVersion)return;preparedDrawing=null;$('drawing-status').textContent=error.message;$('drawing-status').classList.add('drawing-error');preview.classList.remove('out-of-bounds');$('drawing-metrics').textContent='';$('drawing-warnings').textContent='';pathsGroup.replaceChildren();}
}
$('view-machine').onclick=()=>{previewMode='machine';renderDrawing();};
$('view-page').onclick=()=>{if(!plotter.machine.page?.frame)return;previewMode='page';renderDrawing();};
svgInput.onchange=async()=>{
 selectedSvg=null;const file=svgInput.files?.[0];if(!file){$('drawing-step-state').textContent='Choose SVG';svgStatus.textContent='';renderDrawing();return;}
 if(file.size>5*1024*1024){svgInput.value='';svgStatus.textContent='SVG files must be 5 MB or smaller.';renderDrawing();return;}
 try{const source=await file.text(),doc=new DOMParser().parseFromString(source,'image/svg+xml');if(doc.querySelector('parsererror')||doc.documentElement.localName.toLowerCase()!=='svg')throw Error('Invalid SVG file');selectedSvg=file;$('svg-options').hidden=false;svgStatus.textContent=`${file.name} · ${(file.size/1024).toFixed(1)} KB`;$('drawing-step-state').textContent='Preparing';await renderDrawing();}
 catch(error){svgInput.value='';svgStatus.textContent=error.message;renderDrawing();}
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
let plotJobRunning=false,plotProgressText='';
plotOptionIds.forEach(id=>$(id).addEventListener('input',updatePlotControls));
plotter.addEventListener('state',updatePlotControls);plotter.addEventListener('position',updatePlotControls);
plotter.addEventListener('plot-progress',e=>{plotProgressText=`Sending G-code · ${e.detail.sent} / ${e.detail.total} commands acknowledged.`;$('plot-progress').textContent=plotProgressText;});
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
  plotJobRunning=true;plotProgressText=`Sending G-code · 0 / ${commands.length} commands acknowledged.`;updatePlotControls();
  const sent=await plotter.plot(commands);message(`Plot complete · ${sent} commands acknowledged; GRBL is Idle.`);
 }catch(e){message(e.message);$('plot-progress').textContent=e.message;}
 finally{plotJobRunning=false;updatePlotControls();}
};
let positionTimer=null,positionPollRunning=false;
async function pollPosition(){if(!plotter.connected||plotter.busy||plotter.pending||positionPollRunning)return;positionPollRunning=true;try{await plotter.getPosition(1200,true);}catch{}finally{positionPollRunning=false;}}
plotter.addEventListener('state',()=>{const on=plotter.connected;$('status').textContent=on?(plotter.fault?'Reconnect required':plotter.held?'Feed held':'Connected'):'Disconnected';$('connect').disabled=!!plotter.port||!plotter.available;$('disconnect').disabled=!plotter.port;$('baud').disabled=!!plotter.port;renderMachine();document.querySelectorAll('[data-command],#send,#reset,[data-jog]').forEach(b=>{const resume=b.dataset.command==='~',hold=b.dataset.command==='!';b.disabled=!on||plotter.fault||(!hold&&plotter.busy)||(resume?!plotter.held:plotter.held);});$('hold').disabled=!on||plotter.fault;if(on&&!positionTimer){pollPosition();positionTimer=setInterval(pollPosition,500);}else if(!on&&positionTimer){clearInterval(positionTimer);positionTimer=null;}updatePlotControls();});
async function send(command){try{const result=await plotter.command(command);message(result.at(-1)==='ok'?'Acknowledged (movement may still be running).':result.join('\n'));return result;}catch(e){message(e.message);throw e;}}
$('connect').onclick=async()=>{try{$('connect').disabled=true;await plotter.connect(Number($('baud').value));message('Connected. Use Status or Firmware to inspect the controller.');}catch(e){message(e.message);await plotter.disconnect();$('connect').disabled=!plotter.available;}};
$('disconnect').onclick=()=>plotter.disconnect().catch(e=>message(e.message));
document.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>send(b.dataset.command).catch(()=>{}));
function jogDirection(axis,sign){const step=Number($('jog-step').value)*sign;plotter.jog(axis,step).catch(e=>message(e.message));}
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
renderMachine();
if(!plotter.available){$('connect').disabled=true;message('Web Serial is unavailable. Open this page in Chrome using localhost or HTTPS.');}
plotter.state();
