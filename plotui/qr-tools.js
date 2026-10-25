function getQrGenerator(){if(typeof globalThis.qrcode!=='function')throw Error('QR generator is unavailable.');return globalThis.qrcode;}
function getQrScanner(){if(typeof globalThis.jsQR!=='function')throw Error('QR scanner is unavailable.');return globalThis.jsQR;}

export function drawQrCode(canvas,text,targetPixels=420){
 const qr=getQrGenerator()(0,'L');qr.addData(text);qr.make();
 const quiet=4,modules=qr.getModuleCount(),cell=Math.max(2,Math.floor(targetPixels/(modules+quiet*2))),size=(modules+quiet*2)*cell;
 canvas.width=size;canvas.height=size;const context=canvas.getContext('2d');if(!context)throw Error('Canvas 2D is unavailable.');
 context.fillStyle='#fff';context.fillRect(0,0,size,size);context.fillStyle='#000';
 for(let row=0;row<modules;row++)for(let column=0;column<modules;column++)if(qr.isDark(row,column))context.fillRect((column+quiet)*cell,(row+quiet)*cell,cell,cell);
}
function createNativeDetector(){const Detector=globalThis.BarcodeDetector;if(!Detector)return null;try{return new Detector({formats:['qr_code']});}catch{return null;}}

export async function scanQrCode(accept,prompt='Scan the QR code'){
 if(!navigator.mediaDevices?.getUserMedia)throw Error('Camera scanning requires https or localhost.');
 let stream;try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});}catch(error){throw Error(`Could not open the camera (${error instanceof Error?error.message:String(error)}).`);}
 const overlay=document.createElement('div');overlay.className='scanner-overlay';
 const video=document.createElement('video'),caption=document.createElement('p'),cancel=document.createElement('button');video.playsInline=true;video.muted=true;caption.className='scanner-prompt';caption.textContent=prompt;cancel.className='scanner-cancel';cancel.type='button';cancel.textContent='Cancel';overlay.append(video,caption,cancel);video.srcObject=stream;document.body.append(overlay);
 await video.play().catch(()=>{});
 const detector=createNativeDetector(),scanner=getQrScanner(),canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true}),maxWidth=900;
 return new Promise(resolve=>{
  let finished=false,timer=0;
  const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);for(const track of stream.getTracks())track.stop();overlay.remove();resolve(result);};
  cancel.addEventListener('click',()=>finish(null));
  const scanFrame=async()=>{
   if(finished)return;
   try{if(video.readyState>=2&&video.videoWidth>0&&context){let found=null;if(detector){for(const code of await detector.detect(video))if(accept(code.rawValue)){found=code.rawValue;break;}}else{const scale=Math.min(1,maxWidth/video.videoWidth);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);context.drawImage(video,0,0,canvas.width,canvas.height);const image=context.getImageData(0,0,canvas.width,canvas.height),code=scanner(image.data,image.width,image.height,{inversionAttempts:'dontInvert'});if(code&&accept(code.data))found=code.data;}if(found!==null){finish(found);return;}}}catch{/* Ignore transient frame decode errors. */}
   timer=setTimeout(()=>void scanFrame(),120);
  };
  void scanFrame();
 });
}
