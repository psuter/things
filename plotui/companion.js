import {createGuestAnswer} from './live-link.js';
import {drawQrCode,scanQrCode} from './qr-tools.js';

const $=id=>document.getElementById(id),canvas=$('draw-canvas'),ctx=canvas.getContext('2d');
let link=null,pageWidth=210,pageHeight=297,ready=false,tool='draw',active=[],committed=[],history=[],current=null,eraseGesture=null,pointerId=null,sequence=1,uploading=false,sessionBlocked=false;
const MIN_SPACING=.6,MAX_PART_POINTS=400,ERASE_RADIUS_CSS=14;

function status(text,error=false){$('drawing-state').textContent=text;$('drawing-state').classList.toggle('error',error);}
function linkState(text,connected=false,error=false){const el=$('link-state');el.textContent=text;el.classList.toggle('connected',connected);el.classList.toggle('error',error);}
function cloneStrokes(strokes){return strokes.map(stroke=>stroke.map(p=>({x:p.x,y:p.y})));}
function fitCanvas(){
 const box=$('page-wrap').getBoundingClientRect();if(!box.width||!box.height)return;
 const scale=Math.min(box.width/pageWidth,box.height/pageHeight),width=Math.max(1,Math.floor(pageWidth*scale)),height=Math.max(1,Math.floor(pageHeight*scale)),dpr=window.devicePixelRatio||1;
 canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;canvas.width=Math.max(1,Math.round(width*dpr));canvas.height=Math.max(1,Math.round(height*dpr));render();
}
function drawStrokes(strokes,color,lineWidth){
 ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.lineJoin='round';ctx.lineCap='round';
 for(const stroke of strokes){if(stroke.length<2)continue;ctx.beginPath();ctx.moveTo(stroke[0].x,stroke[0].y);for(let i=1;i<stroke.length;i++)ctx.lineTo(stroke[i].x,stroke[i].y);ctx.stroke();}
}
function render(){
 if(!ctx||!pageWidth||!pageHeight)return;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
 const sx=canvas.width/pageWidth,sy=canvas.height/pageHeight;ctx.setTransform(sx,0,0,sy,0,0);ctx.fillStyle='#fffefa';ctx.fillRect(0,0,pageWidth,pageHeight);
 drawStrokes(committed.flatMap(batch=>batch.strokes),'#7b8c80',.32);drawStrokes(active,'#182a22',.38);if(current)drawStrokes([current],'#182a22',.38);
 ctx.setTransform(1,0,0,1,0,0);updateControls();
}
function updateControls(){
 $('undo').disabled=history.length===0;$('clear').disabled=active.length===0;$('plot').disabled=!ready||!active.length||uploading||sessionBlocked;
 canvas.setAttribute('aria-disabled',String(!ready));canvas.dataset.tool=tool;
 $('draw-tool').classList.toggle('selected',tool==='draw');$('erase-tool').classList.toggle('selected',tool==='erase');$('draw-tool').setAttribute('aria-pressed',String(tool==='draw'));$('erase-tool').setAttribute('aria-pressed',String(tool==='erase'));
}
function pointFromEvent(event){const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(pageWidth,(event.clientX-r.left)/r.width*pageWidth)),y:Math.max(0,Math.min(pageHeight,(event.clientY-r.top)/r.height*pageHeight))};}
function distanceToSegment(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
function strokeNearSegment(stroke,a,b,radius){const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/(radius/2)));for(let i=0;i<=steps;i++){const t=i/steps,p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};for(let j=1;j<stroke.length;j++)if(distanceToSegment(p,stroke[j-1],stroke[j])<=radius)return true;}return false;}
function eraseSegment(a,b){const rect=canvas.getBoundingClientRect(),radius=ERASE_RADIUS_CSS/rect.width*pageWidth;active=active.filter(stroke=>!strokeNearSegment(stroke,a,b,radius));}
canvas.addEventListener('pointerdown',event=>{
 if(!ready||pointerId!==null)return;event.preventDefault();pointerId=event.pointerId;canvas.setPointerCapture(pointerId);const p=pointFromEvent(event);
 if(tool==='erase')eraseGesture={before:cloneStrokes(active),last:p};else current=[p];render();
});
canvas.addEventListener('pointermove',event=>{
 if(event.pointerId!==pointerId)return;const p=pointFromEvent(event);
 if(eraseGesture){eraseSegment(eraseGesture.last,p);eraseGesture.last=p;render();return;}
 if(!current)return;const last=current.at(-1);if(Math.hypot(p.x-last.x,p.y-last.y)<MIN_SPACING)return;current.push(p);render();
});
function pointerEnd(event){if(event.pointerId!==pointerId)return;pointerId=null;
 if(eraseGesture){if(active.length!==eraseGesture.before.length)history.push(eraseGesture.before);eraseGesture=null;render();return;}
 if(current){if(current.length>=2){history.push(cloneStrokes(active));active.push(current);}current=null;render();}
}
canvas.addEventListener('pointerup',pointerEnd);canvas.addEventListener('pointercancel',pointerEnd);
$('draw-tool').onclick=()=>{tool='draw';updateControls();};$('erase-tool').onclick=()=>{tool='erase';updateControls();};
$('undo').onclick=()=>{const previous=history.pop();if(previous){active=previous;render();}};
$('clear').onclick=()=>{if(active.length){history.push(cloneStrokes(active));active=[];render();}};

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function sendReliable(message){
 const data=JSON.stringify(message),deadline=Date.now()+15000;
 while(link?.isOpen()&&Date.now()<deadline){if(link.send('reliable',data))return;await sleep(25);}
 throw Error('Connection closed while sending the drawing.');
}
async function submitDrawing(){
 if(!ready||uploading||!active.length)return;const strokes=cloneStrokes(active),id=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`,seq=sequence++;
 uploading=true;active=[];history=[];updateControls();const batch={id,seq,strokes,status:'sending'};committed.push(batch);render();status('Sending strokes to PlotUI…');
 try{
  await sendReliable({type:'batch-start',id,seq,width:pageWidth,height:pageHeight,strokeCount:strokes.length});
  for(let s=0;s<strokes.length;s++)for(let offset=0;offset<strokes[s].length;offset+=MAX_PART_POINTS)await sendReliable({type:'batch-points',id,stroke:s,offset,points:strokes[s].slice(offset,offset+MAX_PART_POINTS)});
  await sendReliable({type:'batch-end',id,seq});batch.status='sent';status('Sent · drawing is locked from undo and erase.');
 }catch(error){batch.status='send uncertain';sessionBlocked=true;status(`${error.message} These strokes remain locked; reconnect before sending another batch.`,true);}
 finally{uploading=false;render();}
}
$('plot').onclick=submitDrawing;

function handleLinkState(text){if(/failed|closed|disconnected/i.test(text)){ready=false;canvas.setAttribute('aria-disabled','true');linkState(text,false,true);status('Connection lost. Reconnect to continue plotting.',true);updateControls();}else linkState(text);}
function onMessage(channel,data){
 if(channel!=='reliable')return;let message;try{message=JSON.parse(data);}catch{return;}
 if(message.type==='hello'){
  if(message.version!==1||!Number.isFinite(message.width)||!Number.isFinite(message.height)||message.width<1||message.height<1){status('PlotUI sent invalid page calibration.',true);return;}
  pageWidth=message.width;pageHeight=message.height;sequence=1;sessionBlocked=false;ready=true;fitCanvas();$('pairing').open=false;status(`Calibrated page · ${pageWidth.toFixed(1)} × ${pageHeight.toFixed(1)} mm`);linkState('Connected',true);return;
 }
 if(message.type==='batch-status'){
  const batch=committed.find(item=>item.id===message.id);if(batch)batch.status=message.status;
  const detail=message.progress?` · ${message.progress.sent}/${message.progress.total}`:'';
  status(`${message.status}${detail}${message.message?` · ${message.message}`:''}`,message.status==='failed');return;
 }
 if(message.type==='error')status(message.message||'PlotUI rejected a drawing batch.',true);
}
const events={onState:handleLinkState,onOpen:()=>{$('answer-qr').hidden=true;$('pairing').open=false;linkState('Connected',true);status('Connected to PlotUI.');},onMessage};
async function connectWithOffer(offer){
 $('scan-offer').disabled=true;$('pairing-status').textContent='Creating reply…';
 try{link?.close();ready=false;$('answer-qr').hidden=true;const result=await createGuestAnswer(offer,events);link=result.link;drawQrCode($('answer-qr'),result.code,420);$('answer-qr').hidden=false;$('pairing-status').textContent='Show this reply QR to PlotUI.';linkState('Waiting for PlotUI…');}
 catch(error){$('pairing-status').textContent=error.message;linkState('Not connected',false,true);}
 finally{$('scan-offer').disabled=false;updateControls();}
}
$('scan-offer').onclick=async()=>{
 $('scan-offer').disabled=true;$('pairing-status').textContent='Opening camera…';
 try{
  const offer=await scanQrCode(text=>/^mgl1[zr]\./.test(text.trim()),'Scan the PlotUI invitation QR code');if(!offer){$('pairing-status').textContent='Scan cancelled.';return;}
  await connectWithOffer(offer);
 }catch(error){$('pairing-status').textContent=error.message;linkState('Not connected',false,true);}
 finally{$('scan-offer').disabled=false;updateControls();}
};
if(location.hash.startsWith('#join=')){
 let offer;try{offer=decodeURIComponent(location.hash.slice('#join='.length));}catch{offer='';}
 if(offer){$('pairing-status').textContent='Invitation opened. Creating reply…';void connectWithOffer(offer);}
}
new ResizeObserver(fitCanvas).observe($('page-wrap'));window.addEventListener('orientationchange',fitCanvas);fitCanvas();updateControls();
