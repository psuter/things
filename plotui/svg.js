const NS='http://www.w3.org/2000/svg';
const GEOMETRY=new Set(['path','line','polyline','polygon','rect','circle','ellipse']);
const CONTAINERS=new Set(['g','a','switch']);
const ATTRS=new Set(['d','points','x','y','x1','y1','x2','y2','width','height','rx','ry','r','cx','cy','transform','viewBox','preserveAspectRatio']);
const PRESENTATION=new Set(['fill','fill-rule','fill-opacity','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-miterlimit','stroke-opacity','stroke-dasharray','stroke-dashoffset','opacity','display','visibility','color','vector-effect']);

// SVG paths may contain many independent strokes, each beginning with M/m.
// Keep those strokes separate so flattening never draws a connector between them.
export function splitPathSubpaths(d){
  const tokens=[...d.matchAll(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)].map(m=>({value:m[0],start:m.index,end:m.index+m[0].length,command:/^[a-zA-Z]$/.test(m[0])}));
  const arity={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7};let cmd=null,commandStart=0,x=0,y=0,sx=0,sy=0,record=null;const records=[];
  const finish=end=>{if(record){record.end=end;records.push(record);record=null;}};
  let i=0;
  while(i<tokens.length){if(tokens[i].command){commandStart=tokens[i].start;cmd=tokens[i++].value; if(cmd.toUpperCase()==='Z'){x=sx;y=sy;cmd=null;}continue;}if(!cmd)break;
    const upper=cmd.toUpperCase(),relative=cmd!==upper,n=arity[upper];if(!n)break;
    if(upper==='M'){
      const first=tokens[i],second=tokens[i+1];if(!first||!second||first.command||second.command)break;
      finish(commandStart);const nx=Number(first.value),ny=Number(second.value);x=relative?x+nx:nx;y=relative?y+ny:ny;sx=x;sy=y;
      record={start:commandStart,first,second,x,y,relative,end:d.length};i+=2;
      // Additional coordinate pairs after moveto are implicit lineto groups.
      cmd=relative?'l':'L';continue;
    }
    if(i+n>tokens.length||tokens.slice(i,i+n).some(t=>t.command))break;
    const values=tokens.slice(i,i+n).map(t=>Number(t.value));
    if(upper==='H')x=relative?x+values[0]:values[0];
    else if(upper==='V')y=relative?y+values[0]:values[0];
    else {const ex=values[n-2],ey=values[n-1];x=relative?x+ex:ex;y=relative?y+ey:ey;}
    i+=n;
  }
  finish(d.length);if(records.length<=1)return[d];
  return records.map(r=>{
    let chunk=d.slice(r.start,r.end);if(r.relative){
      const offset=r.start,edits=[[r.first.start-offset,r.first.end-offset,String(r.x)],[r.second.start-offset,r.second.end-offset,String(r.y)]];
      for(const [a,b,value] of edits.reverse())chunk=chunk.slice(0,a)+value+chunk.slice(b);
    }
    return chunk;
  });
}

function safeInlineStyle(value){
  return value.split(';').flatMap(part=>{const i=part.indexOf(':');if(i<0)return[];const key=part.slice(0,i).trim().toLowerCase(),val=part.slice(i+1).trim();return PRESENTATION.has(key)&&!/[<>]|url\s*\(|expression\s*\(/i.test(val)?[[key,val]]:[];});
}
function isMoveLinePath(d){
  const commands=d.match(/[a-df-zA-DF-Z]/g)||[];
  return commands.length>0&&/[mM]/.test(commands[0])&&commands.every(command=>/[mMlL]/.test(command));
}
function copySafeElement(node,stats){
  const name=node.localName?.toLowerCase();if(!name)return null;
  if(node.hasAttribute('clip-path')||node.hasAttribute('mask')){stats.clipping=true;stats.ignored++;return null;}
  if(!GEOMETRY.has(name)&&!CONTAINERS.has(name)){if(name!=='defs'&&name!=='title'&&name!=='desc'&&name!=='metadata'&&name!=='style')stats.ignored++;if(name==='style')stats.css=true;return null;}
  if(node.hasAttribute('class')||node.hasAttribute('className'))stats.css=true;
  const makeClone=dOverride=>{const clone=document.createElementNS(NS,name);for(const attr of node.attributes){const key=attr.name,value=key==='d'&&dOverride!==undefined?dOverride:attr.value;if(ATTRS.has(key)||PRESENTATION.has(key)){if(!/[<>]|url\s*\(|expression\s*\(/i.test(value))clone.setAttribute(key,value);}}if(node.hasAttribute('style')){const declarations=safeInlineStyle(node.getAttribute('style'));if(declarations.length)clone.setAttribute('style',declarations.map(([k,v])=>`${k}:${v}`).join(';'));}return clone;};
  if(name==='path'){
    const d=node.getAttribute('d')||'';
    if((d.match(/[Mm]/g)||[]).length>1&&!isMoveLinePath(d)){const subpaths=splitPathSubpaths(d);if(subpaths.length>1){const wrapper=document.createElementNS(NS,'g');for(const subpath of subpaths){wrapper.append(makeClone(subpath));stats.geometry++;}return wrapper;}}
  }
  const clone=makeClone();
  if(CONTAINERS.has(name))for(const child of node.children){const safe=copySafeElement(child,stats);if(safe)clone.append(safe);}
  else stats.geometry++;
  return clone;
}
function matrixPoint(point,matrix){const p=new DOMPoint(point.x,point.y).matrixTransform(matrix);return{x:p.x,y:p.y};}
function checkCanceled(signal){if(signal?.aborted){const error=new Error('SVG calculation canceled.');error.name='AbortError';throw error;}}
const yieldToBrowser=async signal=>{await new Promise(resolve=>setTimeout(resolve,0));checkCanceled(signal);};
const affinePoint=(x,y,matrix)=>({x:matrix.a*x+matrix.c*y+matrix.e,y:matrix.b*x+matrix.d*y+matrix.f});
function parseLinearTokens(tokens,matrix){
  const result=[];let current=null,x=0,y=0,command=null,moveFirst=false,tokenIndex=0;
  const finish=()=>{if(current&&current.length>=2)result.push({points:current,closed:false});current=null;};
  while(tokenIndex<tokens.length){
    if(/^[a-zA-Z]$/.test(tokens[tokenIndex])){command=tokens[tokenIndex++];moveFirst=command.toUpperCase()==='M';continue;}
    if(!command)return null;const upper=command.toUpperCase(),relative=command!==upper;
    if(tokenIndex+1>=tokens.length||/^[a-zA-Z]$/.test(tokens[tokenIndex])||/^[a-zA-Z]$/.test(tokens[tokenIndex+1]))return null;
    const a=Number(tokens[tokenIndex++]),b=Number(tokens[tokenIndex++]);
    const nx=relative?x+a:a,ny=relative?y+b:b;x=nx;y=ny;
    if(moveFirst){finish();current=[affinePoint(x,y,matrix)];moveFirst=false;command=relative?'l':'L';}
    else{if(!current)return null;current.push(affinePoint(x,y,matrix));}
  }
  finish();return result;
}
export function parseLinearPathData(d,matrix={a:1,b:0,c:0,d:1,e:0,f:0}){
  if(!isMoveLinePath(d))return null;const tokens=[],re=/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;let match,last=0;
  while((match=re.exec(d))){if(!/^[\s,]*$/.test(d.slice(last,match.index)))return null;tokens.push(match[0]);last=re.lastIndex;}
  if(!/^[\s,]*$/.test(d.slice(last)))return null;return parseLinearTokens(tokens,matrix);
}
async function parseLinearPath(element,matrix,onProgress,signal){
  const d=element.getAttribute('d')||'';if(!isMoveLinePath(d))return null;
  const tokens=[],re=/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;let match,last=0;
  while((match=re.exec(d))){if(!/^[\s,]*$/.test(d.slice(last,match.index)))return null;tokens.push(match[0]);last=re.lastIndex;if(tokens.length%30000===0){onProgress?.('Reading line geometry',tokens.length,d.length);await yieldToBrowser(signal);}}
  if(!/^[\s,]*$/.test(d.slice(last)))return null;
  return parseLinearTokens(tokens,matrix);
}
function boxFor(element,matrix){
  const b=element.getBBox(),corners=[[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]].map(([x,y])=>matrixPoint({x,y},matrix));
  return{minX:Math.min(...corners.map(p=>p.x)),minY:Math.min(...corners.map(p=>p.y)),maxX:Math.max(...corners.map(p=>p.x)),maxY:Math.max(...corners.map(p=>p.y))};
}
function unionBox(a,b){if(!a)return{...b};return{minX:Math.min(a.minX,b.minX),minY:Math.min(a.minY,b.minY),maxX:Math.max(a.maxX,b.maxX),maxY:Math.max(a.maxY,b.maxY)};}
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function pointLineDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(!l2)return dist(p,a);const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2));return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));}
function simplifyOpen(points,tolerance){
  if(points.length<=2||tolerance<=0)return points.slice();const keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;const stack=[[0,points.length-1]],limit=tolerance*tolerance;
  while(stack.length){const [first,last]=stack.pop();let best=-1,bestD=limit;for(let i=first+1;i<last;i++){const d=pointLineDistance(points[i],points[first],points[last]);if(d>bestD){best=i;bestD=d;}}if(best>=0){keep[best]=1;stack.push([first,best],[best,last]);}}
  return points.filter((_,i)=>keep[i]);
}
function simplifyClosed(points,tolerance){
  if(points.length<=4||tolerance<=0)return points.slice();let opposite=1,max=-1;for(let i=1;i<points.length;i++){const d=dist(points[0],points[i]);if(d>max){max=d;opposite=i;}}
  const a=simplifyOpen(points.slice(0,opposite+1),tolerance),b=simplifyOpen([...points.slice(opposite),points[0]],tolerance);
  return [...a.slice(0,-1),...b.slice(0,-1)];
}
function flatten(element,matrix,tolerance){
  const total=element.getTotalLength();if(!Number.isFinite(total)||total<=0)return null;
  const at=s=>matrixPoint(element.getPointAtLength(s),matrix),start=at(0),end=at(total),points=[start];let segmentCount=0;
  const recurse=(s0,p0,s1,p1,depth)=>{
    const sm=(s0+s1)/2,pm=at(sm),q1=at((3*s0+s1)/4),q3=at((s0+3*s1)/4),error=Math.max(pointLineDistance(pm,p0,p1),pointLineDistance(q1,p0,p1),pointLineDistance(q3,p0,p1));
    if(depth>=16||error<=tolerance||s1-s0<1e-7){points.push(p1);return;}
    recurse(s0,p0,sm,pm,depth+1);recurse(sm,pm,s1,p1,depth+1);
  };
  recurse(0,start,total,end,0);
  const clean=points.filter((p,i)=>!i||dist(p,points[i-1])>1e-9);if(clean.length<2)return null;
  const closed=(element.localName==='polygon'||/\bz\s*$/i.test(element.getAttribute('d')||'')||dist(clean[0],clean.at(-1))<Math.max(1e-6,total*1e-8));
  if(closed&&dist(clean[0],clean.at(-1))<1e-5)clean.pop();
  return{points:clean,closed};
}
async function extractPaths(stage,stats,curveTolerance,onProgress,signal){
  const inverse=stage.getScreenCTM().inverse(),items=[...stage.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')],paths=[];let bounds=null,skippedNoStroke=0,skippedDash=0,unsupported=stats.ignored;
  if(items.length>100000)throw Error('This SVG contains more than 100,000 vector shapes; simplify the file before importing it.');
  let result=[],flattenedSegments=0;
  for(let itemIndex=0;itemIndex<items.length;itemIndex++){
    const element=items[itemIndex];checkCanceled(signal);if(itemIndex%64===0){onProgress?.('Measuring SVG geometry',itemIndex,items.length);if(itemIndex)await yieldToBrowser(signal);}
    const style=getComputedStyle(element),opacity=Number.parseFloat(style.opacity),strokeOpacity=Number.parseFloat(style.strokeOpacity),strokeWidth=Number.parseFloat(style.strokeWidth);
    if(style.strokeDasharray&&style.strokeDasharray!=='none'){skippedDash++;continue;}
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.stroke==='none'||!style.stroke||opacity<=0||strokeOpacity<=0||strokeWidth===0){skippedNoStroke++;continue;}
    let total,matrix,box;
    try{matrix=inverse.multiply(element.getScreenCTM());}catch{unsupported++;continue;}
    if(element.localName==='path'){
      const linear=await parseLinearPath(element,matrix,onProgress,signal);
      if(linear){for(const line of linear){flattenedSegments+=line.points.length;if(flattenedSegments>500000)throw Error('SVG geometry exceeds 500,000 points. Increase simplification or use a smaller source file.');for(const point of line.points)bounds=unionBox(bounds,{minX:point.x,minY:point.y,maxX:point.x,maxY:point.y});result.push({...line,stroke:style.stroke,strokeWidth:Number.isFinite(strokeWidth)?strokeWidth:1});}continue;}
    }
    try{total=element.getTotalLength();box=boxFor(element,matrix);}catch{unsupported++;continue;}
    if(!Number.isFinite(total)||total<=0){skippedNoStroke++;continue;}
    bounds=unionBox(bounds,box);paths.push({element,matrix,stroke:style.stroke,strokeWidth:Number.isFinite(strokeWidth)?strokeWidth:1});
  }
  if(!paths.length&&!result.length)throw Error('No visible stroked paths were found. Filled shapes, text, images, and CSS-defined strokes are not plotted yet.');
  const width=bounds.maxX-bounds.minX,height=bounds.maxY-bounds.minY;
  const roughFit=Math.min((stage.dataset.targetWidth-2*stage.dataset.margin)/Math.max(width,1e-9),(stage.dataset.targetHeight-2*stage.dataset.margin)/Math.max(height,1e-9));
  const finalFit=roughFit*(Number(stage.dataset.scalePercent)||100)/100,tolerance=Math.max(0.00001,curveTolerance/finalFit);
  for(let i=0;i<paths.length;i++){checkCanceled(signal);if(i%64===0){onProgress?.('Flattening curves',i,paths.length);if(i)await yieldToBrowser(signal);}const path=paths[i],line=flatten(path.element,path.matrix,tolerance);if(line){flattenedSegments+=line.points.length;if(flattenedSegments>500000)throw Error('Curve flattening exceeded 500,000 points. Increase curve tolerance or simplify the source SVG.');result.push({...line,stroke:path.stroke,strokeWidth:path.strokeWidth});}}
  return{paths:result,bounds,counts:{geometry:stats.geometry,stroked:result.length,skippedNoStroke,skippedDash,unsupported,css:stats.css,clipping:stats.clipping}};
}
function orientFrom(path,index,reverse){if(!path.closed)return reverse?[...path.points].reverse():path.points;const p=path.points,n=p.length;return Array.from({length:n},(_,i)=>p[(index+(reverse?-i:i)+n*2)%n]);}
function compareCandidate(a,b,axis){const av=axis?a.y:a.x,bv=axis?b.y:b.x;if(av!==bv)return av-bv;const ao=axis?a.x:a.y,bo=axis?b.x:b.y;return ao!==bo?ao-bo:a.order-b.order;}
function selectMedian(items,left,right,index,axis){
  const mid=(left+right)>>>1,compare=(a,b)=>compareCandidate(a,b,axis);let pivotIndex;
  if(compare(items[left],items[mid])<0)pivotIndex=compare(items[mid],items[right])<0?mid:compare(items[left],items[right])<0?right:left;
  else pivotIndex=compare(items[left],items[right])<0?left:compare(items[mid],items[right])<0?right:mid;
  const pivot=items[pivotIndex];items[pivotIndex]=items[right];items[right]=pivot;let store=left;
  for(let i=left;i<right;i++)if(compare(items[i],pivot)<0){[items[store],items[i]]=[items[i],items[store]];store++;}
  [items[store],items[right]]=[items[right],items[store]];
  if(store<index)selectMedian(items,store+1,right,index,axis);else if(store>index)selectMedian(items,left,store-1,index,axis);
}
function buildKdTree(items,left=0,right=items.length-1,depth=0,parent=null){
  if(left>right)return null;const node={parent,depth,left:null,right:null,items:null,activeCount:0,minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
  if(right-left<16){node.items=items.slice(left,right+1);node.activeCount=node.items.length;for(const item of node.items){item.leaf=node;node.minX=Math.min(node.minX,item.x);node.minY=Math.min(node.minY,item.y);node.maxX=Math.max(node.maxX,item.x);node.maxY=Math.max(node.maxY,item.y);}return node;}
  const axis=depth%2,index=(left+right)>>>1;selectMedian(items,left,right,index,axis);node.left=buildKdTree(items,left,index,depth+1,node);node.right=buildKdTree(items,index+1,right,depth+1,node);
  node.activeCount=(node.left?.activeCount||0)+(node.right?.activeCount||0);node.minX=Math.min(node.left?.minX??Infinity,node.right?.minX??Infinity);node.minY=Math.min(node.left?.minY??Infinity,node.right?.minY??Infinity);node.maxX=Math.max(node.left?.maxX??-Infinity,node.right?.maxX??-Infinity);node.maxY=Math.max(node.left?.maxY??-Infinity,node.right?.maxY??-Infinity);return node;
}
function boxDistanceSquared(node,x,y){const dx=x<node.minX?node.minX-x:x>node.maxX?x-node.maxX:0,dy=y<node.minY?node.minY-y:y>node.maxY?y-node.maxY:0;return dx*dx+dy*dy;}
function nearestCandidate(node,x,y,best){
  if(!node||!node.activeCount||boxDistanceSquared(node,x,y)>best.distance)return best;
  if(node.items){for(const candidate of node.items){if(!candidate.active)continue;const dx=candidate.x-x,dy=candidate.y-y,distance=dx*dx+dy*dy;if(distance<best.distance||distance===best.distance&&candidate.order<best.candidate.order)best={candidate,distance};}return best;}
  const left=node.left,right=node.right;if(!left)return nearestCandidate(right,x,y,best);if(!right)return nearestCandidate(left,x,y,best);
  const leftDistance=boxDistanceSquared(left,x,y),rightDistance=boxDistanceSquared(right,x,y);
  if(leftDistance<=rightDistance){best=nearestCandidate(left,x,y,best);return nearestCandidate(right,x,y,best);}
  best=nearestCandidate(right,x,y,best);return nearestCandidate(left,x,y,best);
}
function createSortIterator(paths){
  const candidates=[],byPath=new Map();let order=0;
  for(const path of paths){const entries=[];const add=(index,reverse)=>{const point=path.points[index],candidate={x:point.x,y:point.y,path,index,reverse,order:order++,active:true,leaf:null};candidates.push(candidate);entries.push(candidate);};if(path.closed){for(let i=0;i<path.points.length;i++)add(i,false);}else{add(0,false);add(path.points.length-1,true);}byPath.set(path,entries);}
  const root=buildKdTree(candidates),sorted=[];let cursor={x:0,y:0},remaining=paths.length;
  function removePath(path){const touched=new Set();for(const candidate of byPath.get(path)||[]){if(!candidate.active)continue;candidate.active=false;candidate.leaf.activeCount--;for(let node=candidate.leaf;node;node=node.parent)touched.add(node);}for(const node of [...touched].sort((a,b)=>b.depth-a.depth)){node.activeCount=node.items?node.items.reduce((n,c)=>n+(c.active?1:0),0):(node.left?.activeCount||0)+(node.right?.activeCount||0);}}
  return{next(){if(!remaining)return{done:true,value:sorted};const best=nearestCandidate(root,cursor.x,cursor.y,{candidate:{order:Infinity},distance:Infinity});if(!best.candidate.path)return{done:true,value:sorted};const{path,index,reverse}=best.candidate;removePath(path);path.points=orientFrom(path,index,reverse);sorted.push(path);cursor=path.closed?path.points[0]:path.points.at(-1);remaining--;return{done:false,value:sorted.length};}};
}
export function sortPaths(paths){const iterator=createSortIterator(paths);let step;do{step=iterator.next();}while(!step.done);return step.value;}
async function sortPathsAsync(paths,onProgress,signal){const iterator=createSortIterator(paths);let step;while(!(step=iterator.next()).done){checkCanceled(signal);if(step.value%128===0){onProgress?.('Sorting paths',step.value,paths.length);await yieldToBrowser(signal);}}return step.value;}
function dimensions(root){
  const raw=root.getAttribute('viewBox')||root.getAttribute('viewbox');if(raw){const v=raw.trim().split(/[\s,]+/).map(Number);if(v.length===4&&v.every(Number.isFinite)&&v[2]>0&&v[3]>0)return{x:v[0],y:v[1],width:v[2],height:v[3]};}
  const unit=value=>{const m=String(value||'').trim().match(/^([0-9.]+)\s*(px|mm|cm|in|pt|pc)?$/i);if(!m)return 1000;const n=Number(m[1]),factor={px:1,mm:96/25.4,cm:96/2.54,in:96,pt:96/72,pc:16}[m[2]?.toLowerCase()||'px'];return n*factor;};
  const width=unit(root.getAttribute('width')||1000),height=unit(root.getAttribute('height')||1000);if(width<=0||height<=0)throw Error('SVG page dimensions must be positive.');return{x:0,y:0,width,height};
}
function pathLength(path){let sum=0;for(let i=1;i<path.points.length;i++)sum+=dist(path.points[i-1],path.points[i]);if(path.closed&&path.points.length>2)sum+=dist(path.points.at(-1),path.points[0]);return sum;}
async function simplifyAsync(paths,tolerance,onProgress,signal){const result=[];for(let i=0;i<paths.length;i++){checkCanceled(signal);const path=paths[i],points=path.closed?simplifyClosed(path.points,tolerance):simplifyOpen(path.points,tolerance);if(points.length>=(path.closed?3:2))result.push({...path,points});if(i%128===0){onProgress?.('Simplifying paths',i,paths.length);if(i)await yieldToBrowser(signal);}}return result;}
function pathBounds(paths){let b=null;for(const path of paths)for(const p of path.points)b=unionBox(b,{minX:p.x,minY:p.y,maxX:p.x,maxY:p.y});return b;}

export async function importSvg(file,options={}){
  const onProgress=options.onProgress,signal=options.signal;
  onProgress?.('Reading SVG',0,1);
  const text=await file.text();checkCanceled(signal);const doc=new DOMParser().parseFromString(text,'image/svg+xml'),root=doc.documentElement;
  if(doc.querySelector('parsererror')||root.localName?.toLowerCase()!=='svg')throw Error('This file is not a valid SVG document.');
  const vb=dimensions(root),targetWidth=options.targetWidth||210,targetHeight=options.targetHeight||297,margin=options.margin??8;
  const stage=document.createElementNS(NS,'svg');stage.setAttribute('viewBox',`${vb.x} ${vb.y} ${vb.width} ${vb.height}`);stage.setAttribute('preserveAspectRatio',root.getAttribute('preserveAspectRatio')||'xMidYMid meet');stage.setAttribute('aria-hidden','true');stage.classList.add('svg-measure-stage');stage.style.width='1000px';stage.style.height=`${1000*vb.height/vb.width}px`;
  for(const attr of root.attributes){if(PRESENTATION.has(attr.name)){if(!/[<>]|url\s*\(|expression\s*\(/i.test(attr.value))stage.setAttribute(attr.name,attr.value);}else if(attr.name==='style'){const declarations=safeInlineStyle(attr.value);if(declarations.length)stage.setAttribute('style',`${stage.getAttribute('style')||''};${declarations.map(([k,v])=>`${k}:${v}`).join(';')}`);}}
  const stats={geometry:0,ignored:0,css:false};for(const child of root.children){const safe=copySafeElement(child,stats);if(safe)stage.append(safe);}
  document.body.append(stage);
  try{
    stage.dataset.targetWidth=targetWidth;stage.dataset.targetHeight=targetHeight;stage.dataset.margin=margin;stage.dataset.scalePercent=options.scalePercent??100;
    onProgress?.('Measuring geometry',0,1);const computed=await extractPaths(stage,stats,options.curveTolerance??0.2,onProgress,signal),rawBounds=computed.bounds,w=rawBounds.maxX-rawBounds.minX,h=rawBounds.maxY-rawBounds.minY;
    const baseScale=Math.min((targetWidth-2*margin)/Math.max(w,1e-9),(targetHeight-2*margin)/Math.max(h,1e-9)),scale=baseScale*(options.scalePercent??100)/100;
    const centerX=(rawBounds.minX+rawBounds.maxX)/2,centerY=(rawBounds.minY+rawBounds.maxY)/2;
    let paths=[];for(let i=0;i<computed.paths.length;i++){checkCanceled(signal);const path=computed.paths[i];paths.push({...path,points:path.points.map(p=>({x:targetWidth/2+(p.x-centerX)*scale+(options.offsetX||0),y:targetHeight/2+(p.y-centerY)*scale+(options.offsetY||0)}))});if(i%256===0){onProgress?.('Scaling paths',i,computed.paths.length);if(i)await yieldToBrowser(signal);}}
    paths=await simplifyAsync(paths,Math.max(0,options.simplifyTolerance??0.1),onProgress,signal);if(options.sort!==false)paths=await sortPathsAsync(paths,onProgress,signal);
    onProgress?.('Finishing drawing preview',1,1);await yieldToBrowser(signal);
    const bounds=pathBounds(paths),drawLength=paths.reduce((sum,p)=>sum+pathLength(p),0);let penUpLength=0,cursor={x:0,y:0};for(const p of paths){penUpLength+=dist(cursor,p.points[0]);cursor=p.closed?p.points[0]:p.points.at(-1);}
    const strokes=new Set(computed.paths.map(p=>p.stroke));
    const warnings=[];if(computed.counts.css)warnings.push('CSS styles/classes are not fully supported; convert styling to SVG presentation attributes or inline styles.');if(computed.counts.unsupported)warnings.push(`${computed.counts.unsupported} non-path or clipped SVG element(s) were skipped.`);if(computed.counts.skippedDash)warnings.push(`${computed.counts.skippedDash} dashed stroke(s) were skipped; dash patterns are not converted into plotted line segments.`);if(strokes.size>1)warnings.push('Multiple stroke colors are combined into one pen path preview.');
    const outOfBounds=!!bounds&&(bounds.minX<0||bounds.minY<0||bounds.maxX>targetWidth||bounds.maxY>targetHeight);
    return{paths,bounds,targetWidth,targetHeight,drawLength,penUpLength,segmentCount:paths.reduce((n,p)=>n+p.points.length-(p.closed?0:1),0),counts:computed.counts,warnings,outOfBounds,scalePercent:options.scalePercent??100,source:{width:vb.width,height:vb.height}};
  }finally{stage.remove();}
}
