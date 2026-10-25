export function validateStrokeBatch(strokes,width,height){
 if(!Array.isArray(strokes)||strokes.length<1||strokes.length>5000)throw Error('A live batch must contain 1–5,000 strokes.');
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1)throw Error('Invalid calibrated page dimensions.');
 let pointCount=0;
 for(const stroke of strokes){
  if(!Array.isArray(stroke)||stroke.length<2)throw Error('Each live stroke needs at least two points.');
  pointCount+=stroke.length;if(pointCount>200000)throw Error('A live batch exceeds 200,000 points.');
  for(const point of stroke)if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<-.01||point.y<-.01||point.x>width+.01||point.y>height+.01)throw Error('A live stroke extends outside the calibrated page.');
 }
 return{strokeCount:strokes.length,pointCount};
}
