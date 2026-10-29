#pragma once
// Self-contained GPU optics. Only the optional 4x1 probe is read back by the host.
struct alignas(16) DG_ShaderConstants {
 float viewport[4],optics[4],appearance[4],shape[4],history[4],pointer[4],probes01[4],probes23[4];
};
static_assert(sizeof(DG_ShaderConstants)==128);
struct alignas(16) DG_MaterialConstants { float rect[2][4],grid[2][4],surface[2][4]; };
static_assert(sizeof(DG_MaterialConstants)==96);
static const char* DG_Shader=R"HLSL(
cbuffer Params : register(b0) {
 float4 viewport; // width,height,DPI scale,capture halo in physical pixels
 float4 optics; // radius,bezel,thickness in pixels; refraction index
 float4 appearance; // refraction strength,tint,highlight strength,sensing DIP
 float4 shape; // local physical deformation x,y,pressure,material grid count
 float4 history; // dt blend,history valid,atlas width,height
 float4 pointer; // local physical x,y,presence,reserved
 float4 probes01,probes23; // four local physical probe positions
};
cbuffer Materials : register(b1) { float4 materialRect[2],materialGrid[2],materialSurface[2]; };
Texture2D desktop : register(t0);
Texture2D lighting : register(t1);
Texture2D frameTexture : register(t2);
SamplerState linearSampler : register(s0);
struct Vary { float4 position:SV_POSITION; float2 uv:TEXCOORD0; };
Vary VS(uint id:SV_VertexID) {
 Vary o; o.uv=float2((id<<1)&2,id&2);
 o.position=float4(o.uv*float2(2,-2)+float2(-1,1),0,1);return o;
}
float4 sampleAt(float2 p) {
 float2 size=history.z>0?history.zw:viewport.xy+2*viewport.ww;
 return desktop.SampleLevel(linearSampler,(p+viewport.ww)/size,0);
}
float materialBlur(float2 p) {
 float blur=0;
 [unroll]for(int i=0;i<2;i++)if(i<shape.w){
  float4 r=materialRect[i],g=materialGrid[i];
  float2 size=(r.zw-(g.xy-1)*g.zw)/g.xy;
  float2 local=p-r.xy,index=floor(local/(size+g.zw));
  if(all(index>=0)&&all(index<g.xy)){
   float2 cellPoint=local-index*(size+g.zw),q=abs(cellPoint-size*.5)-(size*.5-min(materialSurface[i].x,min(size.x,size.y)*.5));
   float inside=min(materialSurface[i].x,min(size.x,size.y)*.5)-length(max(q,0))-min(max(q.x,q.y),0);
   blur=max(blur,saturate(inside+.5)*materialSurface[i].y);
  }
 }
 return blur;
}
float4 LightPS(Vary input):SV_TARGET {
 // Pixel 0 retains scene direction/luminance. Pixels 1..9 retain a local
 // 3x3 color field, so opposite edges do not collapse to one average hue.
 int cell=clamp((int)floor(input.uv.x*10),0,9);
 int region=max(cell-1,0);
 float2 focus=float2(region%3,region/3)*.5;
 float weight=0,ambient=0;float2 lightMoment=0;
 float3 colorSum=0;float colorWeight=0;
 float2 extent=min(viewport.ww-2,appearance.ww*viewport.zz);
 [loop]for(int y=0;y<24;y++)[loop]for(int x=0;x<48;x++){
  float2 uv=float2((x+.5)/48,(y+.5)/24);
  float2 p=lerp(-extent,viewport.xy+extent,uv);
  float2 tap=(viewport.xy+2*extent)/float2(192,96);
  float3 c=(sampleAt(p+tap).rgb+sampleAt(p-tap).rgb+
    sampleAt(p+float2(tap.x,-tap.y)).rgb+sampleAt(p+float2(-tap.x,tap.y)).rgb)*.25;
  float l=dot(c,float3(.2126,.7152,.0722)),w=l*l;
  lightMoment+=(uv*2-1)*w;weight+=w;ambient+=l;
  float2 support=saturate(1-abs(uv-focus)*2);
  float localWeight=support.x*support.y;
  colorSum+=c*localWeight;colorWeight+=localWeight;
 }
 // Preserve moment magnitude: nearly uniform scenes have no unstable unit
 // direction. History stays on the GPU. Small changes use a longer time
 // constant than deliberate scene changes, so sensitivity does not amplify
 // one-frame noise into flashing highlights.
 // A smaller energy floor retains faint directional contrast in dark scenes.
 // The luminance gate rejects near-black capture noise without forcing a hue.
 float meanLight=ambient/1152;
 float2 v=lightMoment/max(weight,.16)*smoothstep(.003,.025,meanLight);
 float4 current=float4(v,saturate(length(v)*3),meanLight);
 if(cell>0){
  float3 color=colorSum/max(colorWeight,.001);
  current=float4(color,dot(color,float3(.2126,.7152,.0722)));
 }
 float4 previous=frameTexture.Load(int3(cell,0,0));
 float change=cell==0?length(current.xy-previous.xy)+abs(current.w-previous.w)*.25:
   max(abs(current.r-previous.r),max(abs(current.g-previous.g),abs(current.b-previous.b)));
 float response=smoothstep(.012,.12,change);
 // Direction: 60 -> 20ms. Color: 80 -> 30ms. Filter absolute RGB vectors
 // rather than switching hue sectors at a threshold.
 float rate=cell==0?lerp(.333333,1,response):lerp(.25,.666667,response);
 float blend=1-pow(saturate(1-history.x),rate);
 return lerp(previous,current,history.y>.5?blend:1);
}
float cursorLight(float2 uv,float2 normal){
 float2 ray=pointer.xy-uv*viewport.xy;
 float distanceDip=length(ray)/viewport.z;
 float reach=1-smoothstep(10,160,distanceDip);
 float facing=.55+.45*saturate(dot(normal,ray/sqrt(dot(ray,ray)+25*viewport.z*viewport.z)));
 // A wider, softer falloff makes nearby motion visible before the pointer
 // reaches the rim. Both distance and facing remain continuous at the edge.
 return saturate(pointer.z)*reach*(.55+.45*reach)*facing;
}
float4 surroundingLight(float2 uv,float2 normal,out float lightPower){
 // Every region contributes. Sum independent source energies rather than
 // collapsing opposite bright areas into one (possibly cancelling) vector.
 float ambient=lighting.Load(int3(0,0,0)).w;
 float darkSensitivity=1-smoothstep(.18,.50,ambient);
 float2 extent=min(viewport.ww-2,appearance.ww*viewport.zz);
 float2 position=(uv*viewport.xy+extent)/(viewport.xy+2*extent);
 float4 color=0;float total=0,contrast=0;
 [unroll]for(int i=0;i<9;i++){
  float2 focus=float2(i%3,i/3)*.5;
  float2 delta=focus-position;
  float distanceSquared=dot(delta,delta);
  float facing=saturate(dot(normal,delta/sqrt(distanceSquared+.0025)));
  // A nonzero broad lobe includes light from the full surroundings while
  // retaining local color differences around the capsule and both bars.
  float influence=(.35+.65*facing)/(1+8*distanceSquared);
  float4 region=lighting.Load(int3(i+1,0,0));
  color+=region*influence;total+=influence;
  contrast+=max(region.w-ambient,0)*influence;
 }
 float response=contrast/max(total,.001)*8*(1+3*darkSensitivity);
 float scenePower=min(.012*ambient+response,lerp(1,.65,darkSensitivity));
 // Keep pointer response outside the scene cap so bright surroundings do
 // not swallow it. Its own bounded term keeps dark-scene energy controlled.
 lightPower=scenePower+.34*cursorLight(uv,normal)*(1-.25*scenePower);
 return color/max(total,.001);
}
float4 colorReflection(float4 sampled,float pointerAmount){
 float high=max(sampled.r,max(sampled.g,sampled.b));
 float low=min(sampled.r,min(sampled.g,sampled.b));
 float chroma=high-low;
 // Ignore low-saturation colors, even when a bright scene makes their small
 // absolute RGB differences measurable. Above 12%, ramp continuously to 70%.
 float saturation=chroma/max(high,.001);
 float saturationDrive=smoothstep(.12,.70,saturation);
 // Dark scenes need stronger relative color sensitivity as well as a lower
 // luminance gate. Neutral noise remains rejected; light-scene tuning stays.
 float darkSensitivity=1-smoothstep(.18,.50,sampled.w);
 float confidence=smoothstep(lerp(.004,.002,darkSensitivity),lerp(.030,.014,darkSensitivity),chroma);
 float lightScene=smoothstep(.55,.85,sampled.w);
 float sensitivity=(1+7*darkSensitivity+11*lightScene)*(.6+1.2*saturation);
 float drive=saturate(chroma*sensitivity*2.8)*confidence*saturationDrive;
 float3 hue=(sampled.rgb-low)/max(chroma,.001);
 // Keep the sampled hue at full saturation; no white pedestal in the tint.
 float3 reflected=saturate(hue);
 float luminanceGate=smoothstep(lerp(.04,.008,darkSensitivity),lerp(.30,.075,darkSensitivity),sampled.w);
 float energyLimit=lerp(.045,.46,lightScene)+.065*darkSensitivity;
 float energy=drive*luminanceGate*energyLimit*(1+1.35*pointerAmount);
 return float4(reflected,energy);
}
float3 applyColorReflection(float3 baseColor,float4 reflected,float mask,float strength,float sceneLuma){
 float coverage=saturate(mask*reflected.a*strength);
 float3 mixed=lerp(baseColor,reflected.rgb,coverage);
 // Strengthen the color of the visible edge after composition. Increasing
 // just the source saturation is lost when mixed into pale glass/white light.
 float confidence=smoothstep(.002,.020,reflected.a);
 float saturationGain=1+2.5*mask*confidence*strength;
 float gray=dot(mixed,float3(.2126,.7152,.0722));
 float3 vivid=saturate(gray+(mixed-gray)*saturationGain);
 // Gently soften dark-scene chroma after clipping so even vivid primary
 // reflections lose a little saturation. Keep their luminance and hue.
 float darkScene=1-smoothstep(.18,.50,sceneLuma);
 float softening=.08*darkScene*mask*confidence*strength;
 float vividLuma=dot(vivid,float3(.2126,.7152,.0722));
 return lerp(vivid,vividLuma.xxx,softening);
}
float sdRoundedRect(float2 p,float2 size) {
 float r=optics.x;float2 q=abs(p-size/2)-(size/2-r);
 return r-length(max(q,0))-min(max(q.x,q.y),0);
}
float2 deformed(float2 p){
 p*=float2(1+.006*shape.z,1-.022*shape.z);
 float n=length(shape.xy),amount=min(12*viewport.z,n);
 float2 dir=n>.001?shape.xy/n:float2(1,0),cross=float2(-dir.y,dir.x);
 float along=dot(p/max(length(p),.001),dir),tail=pow(max(0,-along),3);
 float breadth=max(1,dot(abs(cross),viewport.xy/2)),side=dot(p,cross)/breadth;
 return p+dir*(amount*(.60*along-.38*tail))-cross*(amount*side*(.30+.52*tail));
}
float4 ProbePS(Vary input):SV_TARGET {
 int i=clamp((int)floor(input.uv.x*4),0,3);
 float2 p=i==0?probes01.xy:i==1?probes01.zw:i==2?probes23.xy:probes23.zw;
 float luma=0;
 [unroll]for(int y=-1;y<=1;y++)[unroll]for(int x=-1;x<=1;x++)
  luma+=dot(sampleAt(p+float2(x,y)*3*viewport.z).rgb,float3(.2126,.7152,.0722));
 return float4(luma/9,0,0,1);
}
float4 LensPS(Vary input):SV_TARGET {
 float2 p=input.uv*viewport.xy,center=viewport.xy/2,q=p-center;
 [unroll]for(int i=0;i<2;i++)q-=deformed(q)-(p-center);
 float2 u=q+center;
 float inside=min(sdRoundedRect(u,viewport.xy),sdRoundedRect(p,viewport.xy));
 float alpha=saturate(inside+.5);if(alpha<=0)return 0;
 float radius=optics.x;
 float2 d=abs(u-center)-(viewport.xy/2-radius),o=max(d,0);
 float len=length(o);
 float2 normal=len>.0001?o/len*sign(u-center):(d.x>d.y?float2(sign(q.x),0):float2(0,sign(q.y)));
 float bezel=optics.y,thickness=optics.z,displacement=0;
 if(inside<bezel){
  float s=clamp(inside/bezel,0,.9999),height=sqrt(saturate(1-(1-s)*(1-s)));
  float next=sqrt(saturate(1-(1-s-.0001)*(1-s-.0001)));
  float derivative=(next-height)/.0001,den=sqrt(derivative*derivative+1);
  float nx=-derivative/den,ny=-1/den,eta=1/optics.w;
  float k=1-eta*eta*(1-ny*ny),term=eta*ny+sqrt(max(k,0));
  displacement=(-term*nx)*((height*bezel+thickness)/(eta-term*ny));
 }
 // SVG's RG/255-.5 mapping has a 127/255 displacement magnitude.
 float2 offset=-normal*displacement*(127.0/255.0)*appearance.x;
 float2 sample=p+offset;float3 c=sampleAt(sample).rgb;float blur=materialBlur(p);
 if(blur>0){
  c=0;
  // Native-resolution 5x5 binomial Gaussian. No reduced-size backdrop texture.
  [unroll]for(int by=-2;by<=2;by++)[unroll]for(int bx=-2;bx<=2;bx++){
   float wx=bx==0?6:abs(bx)==1?4:1,wy=by==0?6:abs(by)==1?4:1;
   c+=sampleAt(sample+float2(bx,by)*blur*.5).rgb*(wx*wy/256);
  }
 }
 float4 light=lighting.Load(int3(0,0,0));
 float darkScene=1-smoothstep(.16,.52,light.w);
 float bright=smoothstep(.28,.82,light.w);
 float scale=viewport.z;
 // In light scenes keep the visible edge near one physical pixel; the broad
 // kube bloom would otherwise become a heavy painted outline.
 float innerWidth=lerp(.82*scale,.55,bright);
 float inner=exp(-pow((inside-.5)/innerWidth,2));
 float middle=exp(-pow((inside-1.75*scale)/(1.25*scale),2))*lerp(1,.35,bright);
 float bloom=exp(-pow((inside-4.4*scale)/(3.4*scale),2))*lerp(1,.22,bright);
 float rim=saturate(inner+middle*.52+bloom*.38);
 float local=dot(c,float3(.2126,.7152,.0722));
 float lightPower;float4 surrounding=surroundingLight(p/viewport.xy,normal,lightPower);
 float4 reflected=colorReflection(surrounding,cursorLight(p/viewport.xy,normal));
 float darkContent=saturate(1-local*1.15);
 float lightContent=saturate(local*1.8);
 float contentGain=lerp(.24+.98*lightContent,.02+1.08*pow(darkContent,1.5),bright);
 float intensity=rim*contentGain*lightPower;
 float tight=(inner*.82+middle*.18)*lightPower*lerp(1,.18+.82*darkContent,bright);
 float3 highlight=(intensity*float3(.72,.69,.65)+tight*float3(.38,.37,.35))*.52;
 highlight*=lerp(1,.58,darkScene);
 // Colored surroundings suppress the neutral specular component so it
 // cannot wash vivid reflections back toward white.
 highlight*=1-.8*smoothstep(.002,.035,reflected.a);
 float veil=saturate((appearance.y*(.62+bright*4))*(1-.55*darkScene));
 float3 veilColor=lerp(float3(.014,.017,.020),float3(.965,.972,.975),bright);
 c=lerp(c,veilColor,veil);
 c=saturate(c+highlight*appearance.z*(1+.18*bright)*(1-bright));
 // Colored reflections replace the fixed near-white light-scene edge.
 // Bounded blending keeps pastel tint visible without clipping to white.
 float reflectionMask=saturate(inner+middle*.24+bloom*.10);
 c=applyColorReflection(c,reflected,reflectionMask,appearance.z,surrounding.w);
 return float4(saturate(c)*alpha,alpha);
}
)HLSL";
