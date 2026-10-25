export class Plotter extends EventTarget {
  constructor({requestPort,storageKey='plotui.machine',startupDelay=2000}={}){super();this.requestPort=requestPort||(()=>navigator.serial.requestPort());this.available=!!requestPort||(typeof navigator!=='undefined'&&'serial'in navigator);this.storageKey=storageKey;this.startupDelay=startupDelay;this.port=null;this.writer=null;this.reader=null;this.pending=null;this.connected=false;this.fault=false;this.held=false;this.buffer='';this.rxBytes=0;this.txBytes=0;this.busy=false;this.position=null;this.quietStatusPoll=false;this.machine=JSON.parse(localStorage.getItem(this.storageKey)||'null')||{homed:false,envelope:null};if(this.machine.home&&!this.machine.home.corner)this.machine.home.corner='top-left';}
  emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
  log(kind,text){this.emit('log',{kind,text});}
  state(){this.emit('state',{connected:this.connected,info:this.port?.getInfo?.(),fault:this.fault,held:this.held,motionLocked:this.motionLocked,invalidated:!!this.machine.invalidated,homed:!!this.machine.homed,rxBytes:this.rxBytes,txBytes:this.txBytes});}
  async connect(baudRate=115200){
    if(this.port) throw Error('Already connected');
    const port=await this.requestPort();
    await port.open({baudRate,dataBits:8,stopBits:1,parity:'none',flowControl:'none'});
    this.port=port;this.writer=port.writable.getWriter();this.reader=port.readable.getReader();this.buffer='';this.fault=false;this.held=false;this.position=null;
    this.machine={...this.machine,homed:false,invalidated:!!this.machine.envelope,page:null};this.saveMachine();
    this.rxBytes=0;this.txBytes=0;this.readTask=this.readLoop();
    this.log('system',`Port open at ${baudRate} baud; waiting for board startup…`);
    await new Promise(r=>setTimeout(r,this.startupDelay));
    if(this.port!==port || this.reader===null) throw Error('Device disconnected during startup');
    this.connected=true;this.state();this.log('system','Ready. No commands sent automatically.');
  }
  async readLoop(){
    const decoder=new TextDecoder();
    try {while(true){const {value,done}=await this.reader.read();if(done)break;this.rxBytes+=value.byteLength;this.feed(decoder.decode(value,{stream:true}));}}
    catch(e){this.log('error',e.message);}
    finally {this.reader?.releaseLock();this.reader=null;this.connected=false;this.abort('Serial connection closed');this.state();}
  }
  feed(text){
    this.buffer+=text;
    if(this.buffer.length>65536){this.buffer='';this.fault=true;this.abort('Oversized serial response');this.state();return;}
    const lines=this.buffer.split('\n');this.buffer=lines.pop();
    for(const raw of lines){const line=raw.trim();if(!line)continue;if(!this.quietStatusPoll||!line.startsWith('<'))this.log('rx',line);
      if(/^Grbl /i.test(line)){this.machine.homed=false;this.machine.invalidated=!!this.machine.envelope;this.machine.page=null;this.position=null;this.saveMachine();this.emit('machine',this.machine);if(this.pending){this.fault=true;this.abort('Controller restarted during command');}this.state();}
      const position=this.parsePosition(line);if(position){this.position=position;this.emit('position',position);}
      if(/^ALARM:/i.test(line)){this.fault=true;this.abort(line);this.state();continue;}
      if(this.pending){this.pending.lines.push(line);if(line==='ok')this.finish();else if(/^error:/i.test(line))this.finish(line);}
    }
  }
  parsePosition(line){
    const m=line.match(/^<[^,>]+(?:,[^,>]*)?,MPos:([-+0-9.eE]+),([-+0-9.eE]+),([-+0-9.eE]+)/);
    return m?{state:line.slice(1).split(/[|,]/,1)[0],x:Number(m[1]),y:Number(m[2]),z:Number(m[3])}:null;
  }
  saveMachine(){localStorage.setItem(this.storageKey,JSON.stringify(this.machine));this.emit('machine',this.machine);}
  async getPosition(timeout=5000,quiet=false){
    if(this.pending)throw Error('Wait for the current command before reading position');
    const before=this.position;
    let timer;
    const response=new Promise((resolve,reject)=>{
      const onPosition=event=>{if(event.detail!==before){this.removeEventListener('position',onPosition);clearTimeout(timer);resolve(event.detail);}};
      this.addEventListener('position',onPosition);
      timer=setTimeout(()=>{this.removeEventListener('position',onPosition);reject(Error('No position response from GRBL'));},timeout);
    });
    if(quiet)this.quietStatusPoll=true;
    try{await this.realtime('?',quiet);return await response;}finally{if(quiet)this.quietStatusPoll=false;}
  }
  async markHome(corner='top-left'){
    const orientations={'top-left':{xSign:1,ySign:-1},'top-right':{xSign:-1,ySign:-1},'bottom-left':{xSign:1,ySign:1},'bottom-right':{xSign:-1,ySign:1}};
    if(!orientations[corner])throw Error('Choose one of the four machine corners');
    if(this.motionLocked)throw Error('Invalidate the motion lock before changing the home corner');
    const position=await this.getPosition();
    if(position.state!=='Idle')throw Error(`Set home only while GRBL is Idle (currently ${position.state})`);
    this.machine={...this.machine,homed:true,home:{x:position.x,y:position.y,corner,...orientations[corner]},page:null,capturedAt:new Date().toISOString()};
    this.saveMachine();this.log('system',`Manual home set at machine X${position.x.toFixed(3)} Y${position.y.toFixed(3)}.`);return position;
  }
  async captureEnvelope(){
    if(!this.machine.homed || !this.machine.home)throw Error('First move the carriage to the top-left and set manual home');
    const position=await this.getPosition();
    if(position.state!=='Idle')throw Error(`Capture the envelope only while GRBL is Idle (currently ${position.state})`);
    const dx=position.x-this.machine.home.x,dy=position.y-this.machine.home.y;
    const width=Math.abs(dx),height=Math.abs(dy);
    const {xSign=1,ySign=-1}=this.machine.home;
    if(dx*xSign<=0 || dy*ySign<=0)throw Error(`Move to the corner opposite ${this.machine.home.corner||'top-left'} before capturing. Measured ΔX ${dx.toFixed(2)} mm, ΔY ${dy.toFixed(2)} mm`);
    if(width<1 || height<1 || width>1000 || height>1000)throw Error(`Measured ${width.toFixed(1)} × ${height.toFixed(1)} mm; expected each dimension between 1 and 1000 mm`);
    this.machine={...this.machine,homed:true,invalidated:false,envelope:{width,height,xSign,ySign},page:null,capturedAt:new Date().toISOString()};
    this.saveMachine();this.log('system',`Machine envelope recorded: ${width.toFixed(2)} × ${height.toFixed(2)} mm.`);return this.machine.envelope;
  }
  async markPageCorner(corner){
    if(!this.canMoveInsideEnvelope)throw Error('Lock the measured machine envelope before calibrating the page');
    if(!['top-left','top-right','bottom-left','bottom-right'].includes(corner))throw Error('Choose one of the four page corners');
    if(this.busy||this.pending)throw Error('Wait for motion to stop before marking a page corner');
    this.busy=true;this.state();
    try{
      const position=await this.getPosition();
      if(position.state!=='Idle')throw Error(`Mark a page corner only while GRBL is Idle (currently ${position.state})`);
      const {home,envelope}=this.machine,x=(position.x-home.x)*(home.xSign??envelope.xSign??1),y=(position.y-home.y)*(home.ySign??envelope.ySign??-1);
      if(x<-.05||x>envelope.width+.05||y<-.05||y>envelope.height+.05)throw Error('The marked page corner is outside the locked machine envelope');
      const previous=this.machine.page||{},previousCheckCorner=previous.frame?.checkCorner|| (previous.frame?'bottom-right':null),restartingFrame=!!previous.frame&&corner!==previousCheckCorner;
      const corners={...(restartingFrame?{}:(previous.corners||{})),[corner]:{x:position.x,y:position.y}};
      let frame=null;
      const names=['top-left','top-right','bottom-left','bottom-right'],opposite={'top-left':'bottom-right','top-right':'bottom-left','bottom-left':'top-right','bottom-right':'top-left'},captured=names.filter(name=>corners[name]);
      if(captured.length>=3){
        const checkCorner=captured.length===3?names.find(name=>!corners[name]):previousCheckCorner;
        const measuredNames=captured.length===4?names.filter(name=>name!==checkCorner):captured;
        const missing=checkCorner||names.find(name=>!corners[name]);
        const anchorName=opposite[missing],anchor=corners[anchorName],adjacent=measuredNames.filter(name=>name!==anchorName).map(name=>corners[name]);
        if(!anchor||adjacent.length!==2)throw Error('Could not identify three distinct page corners; clear calibration and mark them again');
        const expected={x:adjacent[0].x+adjacent[1].x-anchor.x,y:adjacent[0].y+adjacent[1].y-anchor.y};
        const complete={...corners,[missing]:expected},a=complete['top-left'],b=complete['top-right'],c=complete['bottom-left'];
        const vx={x:b.x-a.x,y:b.y-a.y},vy={x:c.x-a.x,y:c.y-a.y},width=Math.hypot(vx.x,vx.y),height=Math.hypot(vy.x,vy.y),area=Math.abs(vx.x*vy.y-vx.y*vy.x);
        if(width<1||height<1||width>1000||height>1000||area<1)throw Error('The three page corners must form a non-degenerate area at least 1 mm wide and high');
        const actual=corners[missing];
        frame={topLeft:a,topRight:b,bottomLeft:c,bottomRight:complete['bottom-right'],vx,vy,width,height,checkCorner,closureError:captured.length===4?Math.hypot(actual.x-expected.x,actual.y-expected.y):null};
      }
      this.machine={...this.machine,page:{corners,frame,capturedAt:new Date().toISOString()}};this.saveMachine();
      const label=corner.replace('-',' ');this.log('system',`Page ${label} recorded at machine X${position.x.toFixed(3)} Y${position.y.toFixed(3)}.`);
      return this.machine.page;
    }finally{this.busy=false;this.state();}
  }
  clearPageCalibration(){this.machine={...this.machine,page:null};this.saveMachine();}
  get motionLocked(){return !!this.machine.envelope&&!this.machine.invalidated;}
  get canMoveInsideEnvelope(){return this.motionLocked&&this.machine.homed&&!!this.machine.home&&!!this.machine.envelope;}
  invalidateLock(){
    if(!this.motionLocked)throw Error('No active motion lock to invalidate');
    this.machine={...this.machine,invalidated:true,page:null};this.saveMachine();
    this.log('system','MOTION LOCK INVALIDATED BY USER. Jog bounds are temporarily disabled.');
  }
  commandAllowedWhileLocked(command){
    const c=command.trim();
    if(['?','!','~','\x18','$$','$I','$G','$#','$N','G90','G21'].includes(c))return true;
    const servo=c.match(/^M3 S(\d{1,4})$/),dwell=c.match(/^G4 P(\d+(?:\.\d*)?|\.\d+)$/);
    return !!servo&&Number(servo[1])<=1000||!!dwell&&Number(dwell[1])<=30;
  }
  async clearEnvelope(){this.machine={homed:this.machine.homed,home:this.machine.home,envelope:null};this.saveMachine();}
  abort(reason){if(this.pending)this.finish(reason);}
  finish(error){const p=this.pending;if(!p)return;this.pending=null;clearTimeout(p.timer);error?p.reject(Error(error)):p.resolve(p.lines);this.state();}
  async signals(values){
    if(!this.connected || !this.port)throw Error('Connect the plotter first');
    if(values){
      if(this.pending)throw Error('Wait for the current command before changing control lines');
      await this.port.setSignals(values);
      this.log('system','Control lines applied: '+JSON.stringify(values));
    }
    const signals=await this.port.getSignals();
    const summary=JSON.stringify({inputSignals:signals,rxBytes:this.rxBytes,txBytes:this.txBytes,pending:this.pending!==null,partialRx:this.buffer});
    this.log('diagnostic',summary);return [summary];
  }
  async jog(axis,distance,{penDown=false,feed=3000}={}){
    if(!this.connected || this.fault || this.held)throw Error('Plotter is not ready to jog');
    if(this.machine.envelope && !this.machine.homed && !this.machine.invalidated)throw Error('Motion lock: GRBL restarted, so manual home is unknown. Invalidate the lock, set home at the corner where the head is now (or jog to a known corner), then capture the opposite corner.');
    if(this.busy || this.pending)throw Error('Wait for the current command before jogging');
    if(!['X','Y'].includes(axis) || ![-100,-50,-10,-1,1,10,50,100].includes(distance))throw Error('Unsupported jog');
    if(penDown&&(!Number.isFinite(feed)||feed<1||feed>10000))throw Error('Invalid pen-down jog speed');
    this.busy=true;this.state();
    try {
      const position=await this.getPosition();
      const env=this.machine.envelope;
      if(this.machine.homed && env && !this.machine.invalidated){
        if(position.state!=='Idle')throw Error(`Wait for motion to stop before jogging (GRBL: ${position.state})`);
        const coord=axis==='X'?(position.x-this.machine.home.x)*env.xSign:(position.y-this.machine.home.y)*env.ySign;
        const target=coord+distance*(axis==='X'?env.xSign:env.ySign);
        const limit=axis==='X'?env.width:env.height;
        if(coord < -0.05 || coord > limit+0.05 || target < -0.05 || target > limit+0.05)throw Error(`Jog would leave recorded machine bounds (0–${limit.toFixed(1)} mm)`);
      }
      if(!penDown){await this.command('M3 S15',100000,true);await new Promise(r=>setTimeout(r,150));}
      await this.command(`G91 G${penDown?'1':'0'} ${axis}${distance}${penDown?` F${feed}`:''}`,100000,true);
      this.log('system',`Jogged ${axis} ${distance>0?'+':''}${distance} mm (relative${penDown?', pen down':''}).`);
    } finally {
      // Restore absolute positioning even when the move returns a GRBL error.
      try {await this.command('G90',100000,true);} finally {this.busy=false;this.state();}
    }
  }
  async goToCenter(){
    if(!this.connected||this.fault||this.held)throw Error('Plotter is not ready to move');
    if(!this.canMoveInsideEnvelope)throw Error('Record the machine envelope and set home before using Go to center');
    if(this.busy||this.pending)throw Error('Wait for the current command before moving');
    this.busy=true;this.state();
    try{
      const position=await this.getPosition();
      if(position.state!=='Idle')throw Error(`Wait for motion to stop before moving (GRBL: ${position.state})`);
      const {home,envelope}=this.machine;
      const x=(position.x-home.x)*envelope.xSign,y=(position.y-home.y)*envelope.ySign;
      const targetX=envelope.width/2,targetY=envelope.height/2;
      if(x<-.05||x>envelope.width+.05||y<-.05||y>envelope.height+.05)throw Error('Current position is outside the recorded envelope; recapture the home point');
      const machineX=home.x+targetX*envelope.xSign,machineY=home.y+targetY*envelope.ySign;
      await this.command('M3 S15',100000,true);await new Promise(r=>setTimeout(r,150));
      await this.command(`G90 G0 X${machineX.toFixed(3)} Y${machineY.toFixed(3)}`,100000,true);
      const deadline=Date.now()+60000;let current;
      do{await new Promise(r=>setTimeout(r,200));current=await this.getPosition(3000);}while(current.state!=='Idle'&&Date.now()<deadline);
      if(current.state!=='Idle')throw Error('Go to center was sent, but GRBL did not return to Idle');
      this.log('system',`Moved to envelope center at X${machineX.toFixed(3)} Y${machineY.toFixed(3)}.`);
    }finally{this.busy=false;this.state();}
  }
  async goToMachineCorner(corner,inset=1){
    if(!this.connected||this.fault||this.held)throw Error('Plotter is not ready to move');
    if(!this.canMoveInsideEnvelope)throw Error('Record and lock the machine envelope before going to a machine corner');
    if(!['top-left','top-right','bottom-left','bottom-right'].includes(corner))throw Error('Choose one of the four machine corners');
    if(!Number.isFinite(inset)||inset<0||inset>50)throw Error('Corner inset must be between 0 and 50 mm');
    if(this.busy||this.pending)throw Error('Wait for the current command before moving');
    const {home,envelope}=this.machine;if(envelope.width<=2*inset||envelope.height<=2*inset)throw Error('Corner inset is too large for this machine envelope');
    this.busy=true;this.state();
    try{
      const position=await this.getPosition();
      if(position.state!=='Idle')throw Error(`Wait for motion to stop before moving (GRBL: ${position.state})`);
      const xSign=home.xSign??envelope.xSign??1,ySign=home.ySign??envelope.ySign??-1;
      const x=(position.x-home.x)*xSign,y=(position.y-home.y)*ySign;
      if(x<-.05||x>envelope.width+.05||y<-.05||y>envelope.height+.05)throw Error('Current head position is outside the recorded envelope');
      const left=corner.endsWith('left'),top=corner.startsWith('top');
      const px=left?inset:envelope.width-inset,py=top?inset:envelope.height-inset;
      const machineX=home.x+(xSign>0?px:px-envelope.width),machineY=home.y+(ySign<0?-py:envelope.height-py);
      await this.command('M3 S15',100000,true);await this.command('G4 P0.1',100000,true);
      await this.command(`G90 G0 X${machineX.toFixed(3)} Y${machineY.toFixed(3)}`,100000,true);
      const deadline=Date.now()+300000;let current;
      do{await new Promise(r=>setTimeout(r,250));current=await this.getPosition(5000,true);}while(current.state!=='Idle'&&Date.now()<deadline);
      if(current.state!=='Idle')throw Error(`Corner move was sent, but GRBL did not return to Idle (currently ${current.state})`);
      this.log('system',`Moved to ${corner} machine corner, ${inset.toFixed(1)} mm inside the measured edges.`);return current;
    }finally{this.busy=false;this.state();}
  }
  async goToPoint(target){
    if(!this.connected||this.fault||this.held)throw Error('Plotter is not ready to move');
    if(!this.canMoveInsideEnvelope)throw Error('Record and lock the machine envelope before moving to the drawing start');
    if(!Number.isFinite(target?.x)||!Number.isFinite(target?.y))throw Error('Drawing start has an invalid machine coordinate');
    if(this.busy||this.pending)throw Error('Wait for the current command before moving');
    this.busy=true;this.state();
    try{
      const position=await this.getPosition();
      if(position.state!=='Idle')throw Error(`Wait for motion to stop before moving (GRBL: ${position.state})`);
      const {home,envelope}=this.machine,xSign=home.xSign??envelope.xSign??1,ySign=home.ySign??envelope.ySign??-1;
      const inside=(point)=>{const x=(point.x-home.x)*xSign,y=(point.y-home.y)*ySign;return x>=-.05&&x<=envelope.width+.05&&y>=-.05&&y<=envelope.height+.05;};
      if(!inside(position))throw Error('Current head position is outside the recorded machine envelope');
      if(!inside(target))throw Error('Drawing start is outside the locked machine envelope');
      await this.command('M3 S15',100000,true);await this.command('G4 P0.1',100000,true);
      await this.command(`G90 G0 X${target.x.toFixed(3)} Y${target.y.toFixed(3)}`,100000,true);
      const deadline=Date.now()+300000;let current;
      do{await new Promise(r=>setTimeout(r,250));current=await this.getPosition(5000,true);}while(current.state!=='Idle'&&Date.now()<deadline);
      if(current.state!=='Idle')throw Error(`Move was sent, but GRBL did not return to Idle (currently ${current.state})`);
      this.log('system',`Moved pen-up to drawing start at X${target.x.toFixed(3)} Y${target.y.toFixed(3)}.`);return current;
    }finally{this.busy=false;this.state();}
  }
  async moveFromHomeOffset(xOffset,yOffset){
    if(!this.connected||this.fault||this.held)throw Error('Plotter is not ready to move');
    if(!this.machine.homed||!this.machine.home)throw Error('Set a starting corner as home before moving by offsets');
    if(this.busy||this.pending)throw Error('Wait for the current command before moving');
    for(const [value,label] of [[xOffset,'Horizontal'],[yOffset,'Vertical']])if(!Number.isFinite(value)||value<0||value>1000)throw Error(`${label} offset must be between 0 and 1000 mm`);
    if(xOffset===0&&yOffset===0)throw Error('Enter a non-zero offset on at least one axis');
    this.busy=true;this.state();
    try{
      const position=await this.getPosition();
      if(position.state!=='Idle')throw Error(`Wait for motion to stop before moving (GRBL: ${position.state})`);
      const {home,envelope}=this.machine,xSign=home.xSign??envelope?.xSign??1,ySign=home.ySign??envelope?.ySign??-1;
      const machineX=home.x+xSign*xOffset,machineY=home.y+ySign*yOffset;
      if(this.motionLocked){
        const x=(machineX-home.x)*xSign,y=(machineY-home.y)*ySign;
        if(x<-.05||x>envelope.width+.05||y<-.05||y>envelope.height+.05)throw Error('Offset would leave the recorded machine envelope. Invalidate the lock only if you are deliberately measuring a different envelope.');
        const currentX=(position.x-home.x)*xSign,currentY=(position.y-home.y)*ySign;
        if(currentX<-.05||currentX>envelope.width+.05||currentY<-.05||currentY>envelope.height+.05)throw Error('Current head position is outside the recorded machine envelope');
      }
      await this.command('M3 S15',100000,true);await this.command('G4 P0.1',100000,true);
      await this.command(`G90 G0 X${machineX.toFixed(3)} Y${machineY.toFixed(3)}`,100000,true);
      const deadline=Date.now()+300000;let current;
      do{await new Promise(r=>setTimeout(r,250));current=await this.getPosition(5000,true);}while(current.state!=='Idle'&&Date.now()<deadline);
      if(current.state!=='Idle')throw Error(`Offset move was sent, but GRBL did not return to Idle (currently ${current.state})`);
      this.log('system',`Moved ${xOffset.toFixed(2)} mm across and ${yOffset.toFixed(2)} mm toward the opposite side from the ${home.corner||'home'} corner.`);
      return current;
    }finally{this.busy=false;this.state();}
  }
  async plot(commands){
    if(!this.connected||this.fault||this.held)throw Error('Plotter is not ready to plot');
    if(!this.canMoveInsideEnvelope)throw Error('Plotting requires a valid homing lock and measured machine envelope');
    if(this.busy||this.pending)throw Error('Wait for the current command before plotting');
    if(!Array.isArray(commands)||!commands.length)throw Error('There are no G-code commands to send');
    this.busy=true;this.state();
    try{
      const before=await this.getPosition();
      if(before.state!=='Idle')throw Error(`Wait for motion to stop before plotting (GRBL: ${before.state})`);
      const {home,envelope}=this.machine,x=(before.x-home.x)*(home.xSign??envelope.xSign??1),y=(before.y-home.y)*(home.ySign??envelope.ySign??-1);
      if(x<-.05||x>envelope.width+.05||y<-.05||y>envelope.height+.05)throw Error('Current head position is outside the measured envelope; re-establish home before plotting');
      this.emit('plot-progress',{sent:0,total:commands.length});
      for(let i=0;i<commands.length;i++){
        if(this.held)throw Error('Plot paused by feed hold. Resume only when ready; the remaining drawing was not sent.');
        await this.command(commands[i],100000,true);
        if((i+1)%10===0||i===commands.length-1)this.emit('plot-progress',{sent:i+1,total:commands.length});
      }
      const deadline=Date.now()+300000;let current;
      do{
        if(this.held)throw Error('Plot is held. GRBL has not confirmed completion; inspect the device before resuming.');
        await new Promise(r=>setTimeout(r,250));current=await this.getPosition(5000,true);
      }while(current.state!=='Idle'&&Date.now()<deadline);
      if(current.state!=='Idle')throw Error(`G-code was acknowledged, but GRBL did not return to Idle (currently ${current.state})`);
      this.log('system',`Plot complete. GRBL acknowledged ${commands.length} commands and returned to Idle.`);
      return commands.length;
    }finally{this.busy=false;this.state();}
  }
  async command(command,timeout=100000,internal=false){
    if(!this.connected || !this.writer)throw Error('Connect the plotter first');
    if(command==='?' || command==='!' || command==='~' || command==='\x18')return this.realtime(command);
    if(this.busy && !internal)throw Error('A jog is in progress');
    if(this.motionLocked && !internal && !this.commandAllowedWhileLocked(command))throw Error('Motion lock: command blocked. Use a bounds-checked jog or invalidate the lock first.');
    if(command==='@home')return this.markHome();
    if(command==='@capture-envelope')return this.captureEnvelope();
    if(command==='@clear-envelope')return this.clearEnvelope();
    if(command==='@signals')return this.signals();
    if(/^@lines [01] [01]$/.test(command)){const [,dtr,rts]=command.split(' ');return this.signals({dataTerminalReady:dtr==='1',requestToSend:rts==='1',break:false});}
    if(this.fault)throw Error('Serial state uncertain; disconnect and reconnect before sending more commands');
    if(this.held&&!internal)throw Error('Feed is held; resume explicitly before sending commands');
    if(this.pending)throw Error('A command is already awaiting acknowledgement');
    command=command.trim();
    if(!command || command.length>120 || /[^\x20-\x7e]/.test(command))throw Error('Enter one ASCII command, at most 120 characters');
    const result=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.fault=true;this.finish('Acknowledgement timed out; command outcome unknown');},timeout);
      this.pending={resolve,reject,timer,lines:[]};
    });
    this.log('tx',command);
    // Install the acknowledgement handler before writing: some devices reply immediately.
    this.writer.write(new TextEncoder().encode(command+'\n')).then(()=>{this.txBytes+=command.length+1;}).catch(e=>{this.fault=true;this.abort(e.message);});
    return result;
  }
  async realtime(command,silent=false){
    if(!this.connected || !this.writer)throw Error('Connect the plotter first');
    if(!['?','!','~','\x18'].includes(command))throw Error('Unsupported real-time command');
    if(command==='!')this.held=true;
    if(command==='~')this.held=false;
    if(command==='\x18'){this.fault=true;this.abort('Soft reset requested; reconnect before further commands');}
    if(!silent)this.log('tx',command==='\x18'?'Ctrl-X (soft reset)':command);
    await this.writer.write(new TextEncoder().encode(command));this.txBytes+=command.length;this.state();
    return ['Real-time byte sent; device response appears in transcript.'];
  }
  async disconnect(){
    this.connected=false;this.abort('Disconnected; command outcome may be unknown');this.state();
    await this.reader?.cancel().catch(()=>{});await this.readTask;
    this.writer?.releaseLock();this.writer=null;
    const port=this.port;this.port=null;await port?.close().catch(()=>{});this.state();
  }
}
