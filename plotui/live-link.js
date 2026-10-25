const ICE_SERVERS=[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}];
const PREFIX='mgl1';

function base64url(bytes){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function unbase64url(text){const padded=text.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-text.length%4)%4),binary=atob(padded),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;}
async function transform(bytes,stream){return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());}

export async function encodeSignal(description){
 const payload=new TextEncoder().encode(JSON.stringify({t:description.type,s:description.sdp||''}));
 if(typeof CompressionStream==='undefined')return`${PREFIX}r.${base64url(payload)}`;
 return`${PREFIX}z.${base64url(await transform(payload,new CompressionStream('gzip')))}`;
}
export async function decodeSignal(input,expected){
 let code=input.trim();const fragment=code.indexOf('#join=');if(fragment>=0)code=code.slice(fragment+6);code=code.replace(/\s+/g,'');
 const match=/^mgl1([zr])\.([A-Za-z0-9_-]+)$/.exec(code);if(!match)throw Error('Invalid connection code.');let bytes=unbase64url(match[2]);
 if(match[1]==='z'){if(typeof DecompressionStream==='undefined')throw Error('This browser cannot read compressed connection codes.');bytes=await transform(bytes,new DecompressionStream('gzip'));}
 let payload;try{payload=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error('The connection code is damaged.');}
 if(payload.t!==expected||typeof payload.s!=='string'||!payload.s)throw Error(`Expected a valid ${expected} code.`);return{type:payload.t,sdp:payload.s};
}
function waitForIce(pc,timeout=5000){
 if(pc.iceGatheringState==='complete')return Promise.resolve();
 return new Promise(resolve=>{const done=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',change);resolve();},change=()=>{if(pc.iceGatheringState==='complete')done();},timer=setTimeout(done,timeout);pc.addEventListener('icegatheringstatechange',change);});
}
function makeLink(pc,events){
 const channels={};let opened=false;const bothOpen=()=>channels.reliable?.readyState==='open'&&channels.fast?.readyState==='open';
 const adopt=channel=>{if(!['reliable','fast'].includes(channel.label))return;channels[channel.label]=channel;channel.onopen=()=>{if(!opened&&bothOpen()){opened=true;events.onOpen?.();}};channel.onmessage=event=>events.onMessage?.(channel.label,typeof event.data==='string'?event.data:'');channel.onclose=()=>events.onState?.(`${channel.label} channel closed`);};
 pc.onconnectionstatechange=()=>events.onState?.(pc.connectionState);
 return{link:{pc,send:(label,data)=>{const channel=channels[label];if(!channel||channel.readyState!=='open'||channel.bufferedAmount>262144)return false;try{channel.send(data);return true;}catch{return false;}},isOpen:bothOpen,close:()=>{for(const channel of Object.values(channels))channel?.close();pc.close();}},adopt};
}
export async function createHostOffer(events){
 const pc=new RTCPeerConnection({iceServers:ICE_SERVERS}),{link,adopt}=makeLink(pc,events);
 try{adopt(pc.createDataChannel('reliable'));adopt(pc.createDataChannel('fast',{ordered:false,maxRetransmits:0}));await pc.setLocalDescription(await pc.createOffer());await waitForIce(pc);if(!pc.localDescription)throw Error('WebRTC did not create an invitation.');return{link,code:await encodeSignal(pc.localDescription)};}catch(error){link.close();throw error;}
}
export async function acceptHostAnswer(link,code){await link.pc.setRemoteDescription(await decodeSignal(code,'answer'));}
export async function createGuestAnswer(code,events){
 const offer=await decodeSignal(code,'offer'),pc=new RTCPeerConnection({iceServers:ICE_SERVERS}),{link,adopt}=makeLink(pc,events);pc.ondatachannel=event=>adopt(event.channel);
 try{await pc.setRemoteDescription(offer);await pc.setLocalDescription(await pc.createAnswer());await waitForIce(pc);if(!pc.localDescription)throw Error('WebRTC did not create a reply.');return{link,code:await encodeSignal(pc.localDescription)};}catch(error){link.close();throw error;}
}
