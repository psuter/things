const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** A small GRBL-compatible serial device used by the browser-only emulator mode. */
export class EmulatorPort {
  constructor(onUpdate=()=>{}){
    this.onUpdate=onUpdate;this.opened=false;this.controller=null;this.encoder=new TextEncoder();this.decoder=new TextDecoder();
    this.position={x:0,y:0,z:0};this.planned={...this.position};this.absolute=true;this.millimetres=true;this.penDown=false;this.held=false;this.feed=3000;this.spindle=15;this.unlocked=true;this.checkMode=false;
    this.signals={dataTerminalReady:true,requestToSend:true,clearToSend:true,dataCarrierDetect:true};
    this.queue=[];this.active=null;this.tick=null;this.closed=false;this.trace=[];
    this.readable=new ReadableStream({start:controller=>{this.controller=controller;},cancel:()=>{this.closed=true;clearInterval(this.tick);}});
    this.writable=new WritableStream({write:chunk=>this.receive(this.decoder.decode(chunk))});
  }
  async open(){this.opened=true;this.closed=false;this.enqueue("Grbl 0.9i ['$' for help]\r\n");this.tick=setInterval(()=>this.advance(),8);this.update();}
  getInfo(){return{usbVendorId:0x1209,usbProductId:0x0001};}
  async getSignals(){return{...this.signals};}
  async setSignals(values){this.signals={...this.signals,...values};}
  enqueue(text){if(this.closed||!this.controller)return;try{this.controller.enqueue(this.encoder.encode(text));}catch{}}
  async receive(text){
    for(const char of text){
      if(char==='?'){this.status();continue;}
      if(char==='!'){this.held=true;this.update();continue;}
      if(char==='~'){this.held=false;this.update();continue;}
      if(char==='\x18'){this.held=false;this.penDown=false;this.absolute=true;this.queue=[];this.active=null;this.planned={...this.position};this.enqueue("Grbl 0.9i ['$' for help]\r\n");this.update();continue;}
      if(char==='\r'||char==='\n')continue;
      // Normal command writes are newline-terminated. The app writes one command at a time.
      if(char) this.commandBuffer=(this.commandBuffer||'')+char;
    }
    if(text.includes('\n')&&this.commandBuffer){const command=this.commandBuffer.trim();this.commandBuffer='';await this.execute(command);}
  }
  async execute(command){
    if(command==='?'){this.status();return;}
    command=command.replace(/\([^)]*\)/g,'').split(';',1)[0].trim();
    if(!command){this.enqueue('ok\r\n');return;}
    if(command==='$I'){this.enqueue('[VER:0.9i]\r\n[OPT:V,15,128]\r\nok\r\n');return;}
    if(command==='$$'){this.enqueue('$0=10\r\n$1=25\r\n$10=3\r\n$30=1000\r\n$31=0\r\n$32=0\r\nok\r\n');return;}
    if(command==='$G'){this.enqueue(`[GC:${this.absolute?'G90':'G91'} G${this.millimetres?'21':'20'} G17 G54 M3 M9 T0 F0 S${this.penDown?80:15}]\r\nok\r\n`);return;}
    if(command==='$#'||command==='$N'){this.enqueue('ok\r\n');return;}
    if(command==='$'){this.enqueue("[HLP:$$ $I $G $# $N $X $H $C]\r\nok\r\n");return;}
    if(command==='$X'){this.unlocked=true;this.enqueue('ok\r\n');return;}
    if(command==='$H'){this.setPosition(0,0);this.unlocked=true;this.enqueue('ok\r\n');return;}
    if(command==='$C'){this.checkMode=!this.checkMode;this.enqueue('ok\r\n');return;}
    if(/^\$RST=/.test(command)){this.absolute=true;this.millimetres=true;this.feed=3000;this.spindle=15;this.penDown=false;this.enqueue('ok\r\n');return;}
    if(/^\$\d+=/.test(command)){this.enqueue('ok\r\n');return;}
    if(command.startsWith('$J='))command=command.slice(3);
    const words=command.trim().toUpperCase().split(/\s+/);
    if(words.includes('G20'))this.millimetres=false;
    if(words.includes('G21'))this.millimetres=true;
    if(words.includes('G90'))this.absolute=true;
    if(words.includes('G91'))this.absolute=false;
    if(words.includes('M0')||words.includes('M00')||words.includes('M1')||words.includes('M01')||words.includes('M2')||words.includes('M02')||words.includes('M30')){await this.waitForQueue();this.penDown=false;this.enqueue('ok\r\n');this.update();return;}
    if(words.includes('G4')||words.includes('G04')){const seconds=Number(command.match(/P([-+\d.eE]+)/i)?.[1]||0);await this.waitForQueue();await sleep(Math.max(0,seconds)*100);this.enqueue('ok\r\n');return;}
    const servo=command.match(/\bM[34]\b/i),spindle=command.match(/\bS([-+\d.eE]+)/i);
    if(spindle)this.spindle=Number(spindle[1]);
    if(servo){this.penDown=this.spindle>=40;this.update();}
    if(/\bM5\b/i.test(command)){this.spindle=0;this.penDown=false;this.update();}
    if(/\bM[789]\b/i.test(command)){}
    const feedWord=command.match(/\bF([-+\d.eE]+)/i);if(feedWord)this.feed=Number(feedWord[1])*(this.millimetres?1:25.4);
    const motion=words.find(word=>['G0','G00','G1','G01'].includes(word));
    if(motion){
      const next={...this.planned};
      for(const [,axis,raw] of command.matchAll(/([XYZ])([-+\d.eE]+)/gi)){
        const value=Number(raw)*(this.millimetres?1:25.4);
        next[axis.toLowerCase()]=this.absolute?value:this.planned[axis.toLowerCase()]+value;
      }
      const feed=this.feed||3000;
      const start={...this.planned},draw=this.penDown&&(motion==='G1'||motion==='G01');
      this.planned=next;if(!this.checkMode)this.queue.push({start,end:next,draw,feed:Math.max(1,feed)});this.enqueue('ok\r\n');this.update();return;
    }
    if(servo||/\bM5\b/i.test(command)||feedWord||spindle||/\bM[789]\b/i.test(command)||words.some(word=>['G17','G18','G19','G20','G21','G40','G49','G54','G55','G56','G57','G58','G59','G61','G64','G80','G90','G91','G91.1'].includes(word))){this.enqueue('ok\r\n');return;}
    this.enqueue('error: Unsupported emulator command\r\n');
  }
  waitForQueue(){return new Promise(resolve=>{const poll=()=>{if(!this.active&&!this.queue.length)resolve();else setTimeout(poll,10);};poll();});}
  setPosition(x,y){this.position={x,y,z:0};this.planned={...this.position};this.queue=[];this.active=null;this.update();}
  status(){const mode=this.held?'Hold':this.active||this.queue.length?'Run':'Idle',p=this.position;this.enqueue(`<${mode},MPos:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)},WPos:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}>\r\n`);}
  advance(){
    if(this.closed||this.held)return;
    const now=performance.now();
    if(!this.active){const segment=this.queue.shift();if(!segment)return;const distance=Math.hypot(segment.end.x-segment.start.x,segment.end.y-segment.start.y,segment.end.z-segment.start.z);this.active={...segment,started:now,duration:Math.max(8,distance/segment.feed*60000/4)};}
    const m=this.active,t=Math.min(1,(now-m.started)/m.duration);
    this.position={x:m.start.x+(m.end.x-m.start.x)*t,y:m.start.y+(m.end.y-m.start.y)*t,z:m.start.z+(m.end.z-m.start.z)*t};
    if(t>=1){this.position={...m.end};if(m.draw){this.trace.push({x1:m.start.x,y1:m.start.y,x2:m.end.x,y2:m.end.y});this.onUpdate({type:'segment',...this.trace.at(-1)});}this.active=null;}
    this.update();
  }
  update(){this.onUpdate({type:'state',position:{...this.position},penDown:this.penDown,moving:!!this.active||this.queue.length>0,held:this.held});}
  async close(){this.closed=true;clearInterval(this.tick);try{this.controller?.close();}catch{}}
}
