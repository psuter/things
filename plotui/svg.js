const NS='http://www.w3.org/2000/svg';
const GEOMETRY=new Set(['path','line','polyline','polygon','rect','circle','ellipse']);
const CONTAINERS=new Set(['g','a','switch']);
const ATTRS=new Set(['d','points','x','y','x1','y1','x2','y2','width','height','rx','ry','r','cx','cy','transform','viewBox','preserveAspectRatio']);
const PRESENTATION=new Set(['fill','fill-rule','fill-opacity','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-miterlimit','stroke-opacity','stroke-dasharray','stroke-dashoffset','opacity','display','visibility','color','vector-effect']);

function safeInlineStyle(value){
  return value.split(';').flatMap(part=>{const i=part.indexOf(':');if(i<0)return[];const key=part.slice(0,i).trim().toLowerCase(),val=part.slice(i+1).trim();return PRESENTATION.has(key)&&!/[<>]|url\s*\(|expression\s*\(/i.test(val)?[[key,val]]:[];});
}
function copySafeElement(node,stats){
  const name=node.localName?.toLowerCase();if(!name)return null;
  if(node.hasAttribute('clip-path')||node.hasAttribute('mask')){stats.clipping=true;stats.ignored++;return null;}
  if(!GEOMETRY.has(name)&&!CONTAINERS.has(name)){if(name!=='defs'&&name!=='title'&&name!=='desc'&&name!=='metadata'&&name!=='style')stats.ignored++;if(name==='style')stats.css=true;return null;}
  if(node.hasAttribute('class')||node.hasAttribute('className'))stats.css=true;
  const clone=document.createElementNS(NS,name);
  for(const attr of node.attributes){const key=attr.name,value=attr.value;if(ATTRS.has(key)||PRESENTATION.has(key)){if(!/[<>]|url\s*\(|expression\s*\(/i.test(value))clone.setAttribute(key,value);}}
  if(node.hasAttribute('style')){const declarations=safeInlineStyle(node.getAttribute('style'));if(declarations.length)clone.setAttribute('style',declarations.map(([k,v])=>`${k}:${v}`).join(';'));}
  if(CONTAINERS.has(name))for(const child of node.children){const safe=copySafeElement(child,stats);if(safe)clone.append(safe);}
  else stats.geometry++;
  return clone;
}
function matrixPoint(point,matrix){const p=new DOMPoint(point.x,point.y).matrixTransform(matrix);return{x:p.x,y:p.y};}
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
function extractPaths(stage,stats,curveTolerance){
  const inverse=stage.getScreenCTM().inverse(),items=[...stage.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')],paths=[];let bounds=null,skippedNoStroke=0,skippedDash=0,unsupported=stats.ignored;
  if(items.length>10000)throw Error('This SVG contains more than 10,000 vector shapes; simplify the file before importing it.');
  for(const element of items){
    const style=getComputedStyle(element),opacity=Number.parseFloat(style.opacity),strokeOpacity=Number.parseFloat(style.strokeOpacity),strokeWidth=Number.parseFloat(style.strokeWidth);
    if(style.strokeDasharray&&style.strokeDasharray!=='none'){skippedDash++;continue;}
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.stroke==='none'||!style.stroke||opacity<=0||strokeOpacity<=0||strokeWidth===0){skippedNoStroke++;continue;}
    let total,matrix,box;
    try{total=element.getTotalLength();matrix=inverse.multiply(element.getScreenCTM());box=boxFor(element,matrix);}catch{unsupported++;continue;}
    if(!Number.isFinite(total)||total<=0){skippedNoStroke++;continue;}
    bounds=unionBox(bounds,box);paths.push({element,matrix,stroke:style.stroke,strokeWidth:Number.isFinite(strokeWidth)?strokeWidth:1});
  }
  if(!paths.length)throw Error('No visible stroked paths were found. Filled shapes, text, images, and CSS-defined strokes are not plotted yet.');
  const width=bounds.maxX-bounds.minX,height=bounds.maxY-bounds.minY;
  const roughFit=Math.min((stage.dataset.targetWidth-2*stage.dataset.margin)/Math.max(width,1e-9),(stage.dataset.targetHeight-2*stage.dataset.margin)/Math.max(height,1e-9));
  const finalFit=roughFit*(Number(stage.dataset.scalePercent)||100)/100,tolerance=Math.max(0.00001,curveTolerance/finalFit),result=[];
  let flattenedSegments=0;for(const path of paths){const line=flatten(path.element,path.matrix,tolerance);if(line){flattenedSegments+=line.points.length;if(flattenedSegments>500000)throw Error('Curve flattening exceeded 500,000 points. Increase curve tolerance or simplify the source SVG.');result.push({...line,stroke:path.stroke,strokeWidth:path.strokeWidth});}}
  return{paths:result,bounds,counts:{geometry:stats.geometry,stroked:result.length,skippedNoStroke,skippedDash,unsupported,css:stats.css,clipping:stats.clipping}};
}
function closestIndex(points,p){let best=0,bestD=Infinity;for(let i=0;i<points.length;i++){const d=dist(points[i],p);if(d<bestD){best=i;bestD=d;}}return best;}
function orientFrom(path,index,reverse){if(!path.closed)return reverse?[...path.points].reverse():path.points;const p=path.points,n=p.length;return Array.from({length:n},(_,i)=>p[(index+(reverse?-i:i)+n*2)%n]);}
export function sortPaths(paths){
  const pending=paths.slice(),sorted=[];let cursor={x:0,y:0};
  while(pending.length){let chosen=-1,startIndex=0,reverse=false,best=Infinity;
    for(let i=0;i<pending.length;i++){const path=pending[i],index=path.closed?closestIndex(path.points,cursor):0,candidates=path.closed?[{index,reverse:false},{index,reverse:true}]:[{index:0,reverse:false},{index:path.points.length-1,reverse:true}];
      for(const candidate of candidates){const first=path.closed?path.points[candidate.index]:candidate.reverse?path.points.at(-1):path.points[0],d=dist(cursor,first);if(d<best){best=d;chosen=i;startIndex=candidate.index;reverse=candidate.reverse;}}
    }
    const [path]=pending.splice(chosen,1);path.points=orientFrom(path,startIndex,reverse);sorted.push(path);cursor=path.closed?path.points[0]:path.points.at(-1);
  }
  return sorted;
}
function dimensions(root){
  const raw=root.getAttribute('viewBox')||root.getAttribute('viewbox');if(raw){const v=raw.trim().split(/[\s,]+/).map(Number);if(v.length===4&&v.every(Number.isFinite)&&v[2]>0&&v[3]>0)return{x:v[0],y:v[1],width:v[2],height:v[3]};}
  const unit=value=>{const m=String(value||'').trim().match(/^([0-9.]+)\s*(px|mm|cm|in|pt|pc)?$/i);if(!m)return 1000;const n=Number(m[1]),factor={px:1,mm:96/25.4,cm:96/2.54,in:96,pt:96/72,pc:16}[m[2]?.toLowerCase()||'px'];return n*factor;};
  const width=unit(root.getAttribute('width')||1000),height=unit(root.getAttribute('height')||1000);if(width<=0||height<=0)throw Error('SVG page dimensions must be positive.');return{x:0,y:0,width,height};
}
function pathLength(path){let sum=0;for(let i=1;i<path.points.length;i++)sum+=dist(path.points[i-1],path.points[i]);if(path.closed&&path.points.length>2)sum+=dist(path.points.at(-1),path.points[0]);return sum;}
function simplify(paths,tolerance){return paths.map(p=>({...p,points:p.closed?simplifyClosed(p.points,tolerance):simplifyOpen(p.points,tolerance)})).filter(p=>p.points.length>=(p.closed?3:2));}
function pathBounds(paths){let b=null;for(const path of paths)for(const p of path.points)b=unionBox(b,{minX:p.x,minY:p.y,maxX:p.x,maxY:p.y});return b;}

export async function importSvg(file,options={}){
  const text=await file.text(),doc=new DOMParser().parseFromString(text,'image/svg+xml'),root=doc.documentElement;
  if(doc.querySelector('parsererror')||root.localName?.toLowerCase()!=='svg')throw Error('This file is not a valid SVG document.');
  const vb=dimensions(root),targetWidth=options.targetWidth||210,targetHeight=options.targetHeight||297,margin=options.margin??8;
  const stage=document.createElementNS(NS,'svg');stage.setAttribute('viewBox',`${vb.x} ${vb.y} ${vb.width} ${vb.height}`);stage.setAttribute('preserveAspectRatio',root.getAttribute('preserveAspectRatio')||'xMidYMid meet');stage.setAttribute('aria-hidden','true');stage.classList.add('svg-measure-stage');stage.style.width='1000px';stage.style.height=`${1000*vb.height/vb.width}px`;
  for(const attr of root.attributes){if(PRESENTATION.has(attr.name)){if(!/[<>]|url\s*\(|expression\s*\(/i.test(attr.value))stage.setAttribute(attr.name,attr.value);}else if(attr.name==='style'){const declarations=safeInlineStyle(attr.value);if(declarations.length)stage.setAttribute('style',`${stage.getAttribute('style')||''};${declarations.map(([k,v])=>`${k}:${v}`).join(';')}`);}}
  const stats={geometry:0,ignored:0,css:false};for(const child of root.children){const safe=copySafeElement(child,stats);if(safe)stage.append(safe);}
  document.body.append(stage);
  try{
    stage.dataset.targetWidth=targetWidth;stage.dataset.targetHeight=targetHeight;stage.dataset.margin=margin;stage.dataset.scalePercent=options.scalePercent??100;
    const computed=extractPaths(stage,stats,options.curveTolerance??0.2),rawBounds=computed.bounds,w=rawBounds.maxX-rawBounds.minX,h=rawBounds.maxY-rawBounds.minY;
    const baseScale=Math.min((targetWidth-2*margin)/Math.max(w,1e-9),(targetHeight-2*margin)/Math.max(h,1e-9)),scale=baseScale*(options.scalePercent??100)/100;
    const centerX=(rawBounds.minX+rawBounds.maxX)/2,centerY=(rawBounds.minY+rawBounds.maxY)/2;
    if(options.sort!==false&&computed.paths.length>3000)throw Error('Path sorting is limited to 3,000 strokes to keep the browser responsive.');
    let paths=computed.paths.map(path=>({...path,points:path.points.map(p=>({x:targetWidth/2+(p.x-centerX)*scale+(options.offsetX||0),y:targetHeight/2+(p.y-centerY)*scale+(options.offsetY||0)}))}));
    paths=simplify(paths,Math.max(0,options.simplifyTolerance??0.1));if(options.sort!==false)paths=sortPaths(paths);
    const bounds=pathBounds(paths),drawLength=paths.reduce((sum,p)=>sum+pathLength(p),0);let penUpLength=0,cursor={x:0,y:0};for(const p of paths){penUpLength+=dist(cursor,p.points[0]);cursor=p.closed?p.points[0]:p.points.at(-1);}
    const strokes=new Set(computed.paths.map(p=>p.stroke));
    const warnings=[];if(computed.counts.css)warnings.push('CSS styles/classes are not fully supported; convert styling to SVG presentation attributes or inline styles.');if(computed.counts.unsupported)warnings.push(`${computed.counts.unsupported} non-path or clipped SVG element(s) were skipped.`);if(computed.counts.skippedDash)warnings.push(`${computed.counts.skippedDash} dashed stroke(s) were skipped; dash patterns are not converted into plotted line segments.`);if(strokes.size>1)warnings.push('Multiple stroke colors are combined into one pen path preview.');
    const outOfBounds=!!bounds&&(bounds.minX<0||bounds.minY<0||bounds.maxX>targetWidth||bounds.maxY>targetHeight);
    return{paths,bounds,targetWidth,targetHeight,drawLength,penUpLength,segmentCount:paths.reduce((n,p)=>n+p.points.length-(p.closed?0:1),0),counts:computed.counts,warnings,outOfBounds,scalePercent:options.scalePercent??100,source:{width:vb.width,height:vb.height}};
  }finally{stage.remove();}
}
