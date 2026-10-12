export function mapMachineToEnvelope(point,machine){
  if(!machine?.home||!machine?.envelope)throw Error('Record the machine home and envelope before mapping a machine coordinate');
  const {home,envelope}=machine,xSign=home.xSign??envelope.xSign??1,ySign=home.ySign??envelope.ySign??-1;
  const x=(point.x-home.x)*xSign,y=(point.y-home.y)*ySign;
  const mappedX=xSign>0?x:envelope.width-x,mappedY=ySign<0?y:envelope.height-y;
  return{x:mappedX===0?0:mappedX,y:mappedY===0?0:mappedY};
}

export function mapMachineToPage(point,frame){
  const dx=point.x-frame.topLeft.x,dy=point.y-frame.topLeft.y,det=frame.vx.x*frame.vy.y-frame.vx.y*frame.vy.x;
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)throw Error('Page frame is degenerate');
  const u=(dx*frame.vy.y-dy*frame.vy.x)/det,v=(frame.vx.x*dy-frame.vx.y*dx)/det;
  return{x:u*frame.width,y:v*frame.height};
}

export function mapPointToMachine(point,machine){
  if(!machine?.home||!machine?.envelope)throw Error('Record the machine home and envelope before plotting');
  const {home,envelope}=machine;
  if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y))throw Error('Drawing contains an invalid coordinate');
  const page=machine.page?.frame;
  let result;
  if(page){
    if(page.closureError!==null&&page.closureError>3)throw Error(`Page corner fit error is ${page.closureError.toFixed(1)} mm; recalibrate the page corners before plotting`);
    if(point.x < -0.001 || point.y < -0.001 || point.x > page.width + 0.001 || point.y > page.height + 0.001)throw Error(`Drawing is outside the calibrated page (${page.width.toFixed(1)} × ${page.height.toFixed(1)} mm)`);
    result={x:page.topLeft.x+point.x/page.width*page.vx.x+point.y/page.height*page.vy.x,y:page.topLeft.y+point.x/page.width*page.vx.y+point.y/page.height*page.vy.y};
  }else{
    if(point.x < -0.001 || point.y < -0.001 || point.x > envelope.width + 0.001 || point.y > envelope.height + 0.001)throw Error(`Drawing is outside the measured machine envelope (${envelope.width.toFixed(1)} × ${envelope.height.toFixed(1)} mm)`);
    const xSign = home.xSign ?? envelope.xSign ?? 1, ySign = home.ySign ?? envelope.ySign ?? -1;
    // Keep the preview oriented top-left to bottom-right regardless of which
    // physical corner the user selected as the machine origin.
    result={x:home.x+(xSign>0?point.x:point.x-envelope.width),y:home.y+(ySign<0?-point.y:envelope.height-point.y)};
  }
  const xSign=home.xSign??envelope.xSign??1,ySign=home.ySign??envelope.ySign??-1;
  const machineX=(result.x-home.x)*xSign,machineY=(result.y-home.y)*ySign;
  if(machineX < -0.001 || machineY < -0.001 || machineX > envelope.width + 0.001 || machineY > envelope.height + 0.001)throw Error('Drawing extends outside the locked machine envelope');
  return result;
}

export function buildPlotJob(paths, machine, options = {}) {
  if (!machine?.home || !machine?.envelope) throw Error('Record the machine home and envelope before plotting');
  if (!paths?.length) throw Error('There are no paths to plot');
  const { home } = machine;
  const penUp = integer(options.penUp ?? 15, 'Pen-up value', 0, 1000);
  const penDown = integer(options.penDown ?? 80, 'Pen-down value', 0, 1000);
  const penUpDelay = number(options.penUpDelay ?? 0.1, 'Pen-up delay', 0, 30);
  const penDownDelay = number(options.penDownDelay ?? 0.2, 'Pen-down delay', 0, 30);
  const drawFeed = number(options.drawFeed ?? 3000, 'Drawing speed', 1, 10000);
  const travelMode = options.travelMode ?? 'rapid';
  if (!['rapid', 'feed'].includes(travelMode)) throw Error('Choose a supported travel mode');
  const travelFeed = number(options.travelFeed ?? 1000, 'Travel speed', 1, 10000);
  const words = p => `X${p.x.toFixed(3)} Y${p.y.toFixed(3)}`;
  const commands = ['G21', 'G90', `M3 S${penUp}`, `G4 P${penUpDelay}`];
  for (const path of paths) {
    if (!Array.isArray(path.points) || path.points.length < 2) continue;
    const points = path.points.map(point=>mapPointToMachine(point,machine));
    const travel = travelMode === 'rapid' ? `G0 ${words(points[0])}` : `G1 ${words(points[0])} F${travelFeed}`;
    commands.push(travel, `M3 S${penDown}`, `G4 P${penDownDelay}`);
    const drawPoints = path.closed ? [...points.slice(1), points[0]] : points.slice(1);
    for (const point of drawPoints) commands.push(`G1 ${words(point)} F${drawFeed}`);
    commands.push(`M3 S${penUp}`, `G4 P${penUpDelay}`);
  }
  if (commands.length === 4) throw Error('There are no drawable paths');
  return commands;
}

function number(value, label, min, max) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw Error(`${label} must be between ${min} and ${max}`);
  return result;
}
function integer(value, label, min, max) {
  const result = number(value, label, min, max);
  if (!Number.isInteger(result)) throw Error(`${label} must be a whole number`);
  return result;
}
