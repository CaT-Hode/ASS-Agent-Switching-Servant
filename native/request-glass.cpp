#include <node_api.h>
#include "desktop-glass/DesktopGlass.h"
#include <dwmapi.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

namespace {
HWND owner=nullptr;DG_Handle glass=nullptr;HMONITOR monitor=nullptr;
UINT_PTR timer=0;ULONGLONG retryAt=0,lastTick=0;int width=0,height=0;
float radius=36,inset=10,targetWidth=0,targetHeight=0,visualWidth=0,visualHeight=0,widthVelocity=0,heightVelocity=0;
int requestRows=0;bool dragging=false,moving=false,reduced=false;
POINT grip{},targetOrigin{};HRESULT failure=S_OK;
uint64_t creates=0,moves=0;
constexpr UINT frameInterval=10;
#ifdef ASS_GLASS_REVIEW
bool frozen=false;
#endif

void Release(){if(glass){DG_Destroy(glass);glass=nullptr;}width=height=0;}
void Stop(){if(timer){KillTimer(nullptr,timer);timer=0;}dragging=moving=false;Release();owner=nullptr;}
void Fail(HRESULT hr){failure=hr;Release();retryAt=GetTickCount64()+500;}
void Spring(float& value,float& speed,float target,float dt){
    if(reduced||std::abs(value-target)<.05f&&std::abs(speed)<.2f){value=target;speed=0;return;}
    constexpr float damping=17,omega=14.52584f,stiffness=500;
    float offset=value-target,e=std::exp(-damping*dt),c=std::cos(omega*dt),s=std::sin(omega*dt);
    value=target+e*(offset*c+(speed+damping*offset)*s/omega);
    speed=e*(speed*c-(damping*speed+stiffness*offset)*s/omega);
}
void CALLBACK Frame(HWND,UINT,UINT_PTR,DWORD){
    if(!IsWindow(owner)||!IsWindowVisible(owner))return;
    if(GetTickCount64()<retryAt)return;
    RECT client{};POINT origin{};GetClientRect(owner,&client);ClientToScreen(owner,&origin);
    float dpi=GetDpiForWindow(owner)/96.f;int pad=int(std::lround(inset*dpi));
    POINT cursor{};GetCursorPos(&cursor);int x=origin.x+pad,y=origin.y+pad;
    ULONGLONG now=GetTickCount64();float dt=std::clamp((now-lastTick)/1000.f,.001f,.05f);lastTick=now;
    Spring(visualWidth,widthVelocity,targetWidth*dpi,dt);Spring(visualHeight,heightVelocity,targetHeight*dpi,dt);
    int w=int(std::lround(visualWidth))-2*pad,h=int(std::lround(visualHeight))-2*pad;if(w<1||h<1)return;
    if(dragging){
        x=cursor.x-grip.x;y=cursor.y-grip.y;
        targetOrigin={x,y};moving=true;
        if(!(GetAsyncKeyState(VK_LBUTTON)&0x8000))dragging=false;
    }
    if(moving&&!dragging){x=targetOrigin.x;y=targetOrigin.y;}
    RECT target{x,y,x+w,y+h};HMONITOR current=MonitorFromRect(&target,MONITOR_DEFAULTTONEAREST);
    int capacityWidth=int(std::ceil((std::max(640.f,targetWidth)+32)*dpi))-2*pad;
    int capacityHeight=int(std::ceil((std::max(362.f,targetHeight)+32)*dpi))-2*pad;
    if(!glass||capacityWidth!=width||capacityHeight!=height){
        Release();HRESULT hr=DG_Create(owner,capacityWidth,capacityHeight,&glass);if(FAILED(hr)){Fail(hr);return;}
        width=capacityWidth;height=capacityHeight;monitor=current;++creates;
        hr=DG_SelectMonitor(glass,monitor,FALSE,TRUE);if(FAILED(hr)){Fail(hr);return;}
    }else if(current!=monitor){
        HRESULT hr=DG_SelectMonitor(glass,current,FALSE,TRUE);if(FAILED(hr)){Fail(hr);return;}monitor=current;
    }
    DG_Parameters p{};DG_DefaultParameters(&p);p.dpi_scale=dpi;p.corner_radius_dip=radius;
    p.bezel_dip=22;p.thickness_dip=72;p.tint=.08f;p.highlight_strength=.64f;
    p.pointer_screen_x_px=float(cursor.x);p.pointer_screen_y_px=float(cursor.y);p.pointer_presence=1;
    p.probe_count=3;p.probe_interval=20;
    for(unsigned i=0;i<3;++i)p.probes[i]={w*(.2f+.3f*i),h*.5f};
    float inner=std::clamp(radius-24.f,0.f,12.f)*dpi;
    if(requestRows)p.materials[p.material_count++]={24*dpi,24*dpi,w-48*dpi,(requestRows*29-4)*dpi,1,float(requestRows),0,4*dpi,inner,2.8f*dpi};
    p.materials[p.material_count++]={24*dpi,h-76*dpi,w-48*dpi,52*dpi,12,2,4*dpi,4*dpi,inner,3.2f*dpi};
    HRESULT hr=DG_SetViewport(glass,w,h);if(FAILED(hr)){Fail(hr);return;}
    hr=DG_Render(glass,x,y,&p);if(FAILED(hr)){Fail(hr);return;}
    hr=DG_Present(glass);if(FAILED(hr)){Fail(hr);return;}
    if(hr==S_OK){
        failure=S_OK;DG_Stats stats{};DG_GetStats(glass,&stats);
        // The origin and size belong to this submitted texture. Drag position
        // has no velocity prediction or spring; only size is elastic.
        if((moving&&(origin.x+pad!=stats.presented_x_px||origin.y+pad!=stats.presented_y_px))||
           client.right!=stats.presented_width_px+2*pad||client.bottom!=stats.presented_height_px+2*pad){
            SetWindowPos(owner,nullptr,stats.presented_x_px-pad,stats.presented_y_px-pad,stats.presented_width_px+2*pad,stats.presented_height_px+2*pad,SWP_NOZORDER|SWP_NOACTIVATE);
            ++moves;}
        if(!dragging&&stats.presented_x_px==targetOrigin.x&&stats.presented_y_px==targetOrigin.y)moving=false;
    }
}
napi_value Undefined(napi_env env){napi_value v;napi_get_undefined(env,&v);return v;}
double Number(napi_env env,napi_value object,const char* name,double fallback){
    napi_value v;double value;bool present=false;napi_has_named_property(env,object,name,&present);
    return present&&napi_get_named_property(env,object,name,&v)==napi_ok&&napi_get_value_double(env,v,&value)==napi_ok&&std::isfinite(value)?value:fallback;
}
void Put(napi_env env,napi_value o,const char* key,double value){napi_value v;napi_create_double(env,value,&v);napi_set_named_property(env,o,key,v);}
napi_value Options(napi_env env,napi_callback_info info){
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);
    if(n){radius=float(std::clamp(Number(env,args[0],"radius",radius),8.,48.));inset=float(Number(env,args[0],"inset",inset));
        targetWidth=float(Number(env,args[0],"width",targetWidth));targetHeight=float(Number(env,args[0],"height",targetHeight));
        requestRows=int(std::clamp(Number(env,args[0],"rows",requestRows),0.,8.));
        reduced=Number(env,args[0],"reducedMotion",reduced?1:0)!=0;}
    return Undefined(env);
}
napi_value Start(napi_env env,napi_callback_info info){
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);void* bytes=nullptr;size_t size=0;
    if(!n||napi_get_buffer_info(env,args[0],&bytes,&size)!=napi_ok||size<sizeof(HWND)){napi_throw_error(env,nullptr,"Invalid widget window handle");return nullptr;}
    Stop();std::memcpy(&owner,bytes,sizeof(HWND));
    if(!IsWindow(owner)||GetWindowThreadProcessId(owner,nullptr)!=GetCurrentThreadId()){
        owner=nullptr;napi_throw_error(env,nullptr,"Glass must attach on the widget UI thread");return nullptr;}
    HRESULT hr=DG_ExcludeWindowFromCapture(owner);if(FAILED(hr)){owner=nullptr;napi_throw_error(env,nullptr,"Could not exclude widget from desktop capture");return nullptr;}
    int corners=1;DwmSetWindowAttribute(owner,33,&corners,sizeof(corners));
    BOOL animations=TRUE;if(SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&animations,0))reduced=!animations;
    RECT client{};GetClientRect(owner,&client);float dpi=GetDpiForWindow(owner)/96.f;
    visualWidth=float(client.right);visualHeight=float(client.bottom);widthVelocity=heightVelocity=0;
    if(targetWidth<=0)targetWidth=visualWidth/dpi;if(targetHeight<=0)targetHeight=visualHeight/dpi;
    failure=S_OK;retryAt=0;lastTick=GetTickCount64();timer=SetTimer(nullptr,0,frameInterval,Frame);Frame(nullptr,0,0,0);
    return Undefined(env);
}
napi_value End(napi_env env,napi_callback_info){Stop();return Undefined(env);}
napi_value Drag(napi_env env,napi_callback_info){
#ifdef ASS_GLASS_REVIEW
    if(frozen)return Undefined(env);
#endif
    if(owner){POINT cursor{},origin{};GetCursorPos(&cursor);ClientToScreen(owner,&origin);float dpi=GetDpiForWindow(owner)/96.f;
        int pad=int(std::lround(inset*dpi));grip={cursor.x-origin.x-pad,cursor.y-origin.y-pad};dragging=true;Frame(nullptr,0,0,0);}
    return Undefined(env);
}
napi_value Stats(napi_env env,napi_callback_info){
    DG_Stats s{};if(glass)DG_GetStats(glass,&s);napi_value result;napi_create_object(env,&result);
    Put(env,result,"submitted",double(s.submitted));Put(env,result,"presented",double(s.presented));Put(env,result,"captured",double(s.captured));
    Put(env,result,"backend",s.backend);Put(env,result,"error",static_cast<unsigned long>(failure));
    Put(env,result,"captureMs",s.capture_ms);Put(env,result,"gpuMs",s.gpu_ms);Put(env,result,"readbackBytes",double(s.probe_readback_bytes));
    Put(env,result,"renderToPresentMs",s.render_to_present_ms);Put(env,result,"sourceAgeMs",s.source_age_ms);
    Put(env,result,"luminance",(s.probe_luminance[0]+s.probe_luminance[1]+s.probe_luminance[2])/3.);
    Put(env,result,"creates",double(creates));Put(env,result,"moves",double(moves));
    Put(env,result,"x",s.presented_x_px);Put(env,result,"y",s.presented_y_px);
    Put(env,result,"width",s.presented_width_px);Put(env,result,"height",s.presented_height_px);return result;
}
#ifdef ASS_GLASS_REVIEW
// Drives only the isolated test host through the real render/present path.
// It does not synthesize OS mouse input and is absent from the shipped module.
napi_value ReviewOrigin(napi_env env,napi_callback_info info){
    size_t n=2;napi_value args[2];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);int32_t x=0,y=0;
    if(n<2||napi_get_value_int32(env,args[0],&x)!=napi_ok||napi_get_value_int32(env,args[1],&y)!=napi_ok)return Undefined(env);
    if(owner&&!frozen){targetOrigin={x,y};moving=true;Frame(nullptr,0,0,0);}
    napi_value result=Stats(env,info);POINT point{};if(owner)ClientToScreen(owner,&point);
    int pad=owner?int(std::lround(inset*GetDpiForWindow(owner)/96.f)):0;
    Put(env,result,"ownerX",point.x+pad);Put(env,result,"ownerY",point.y+pad);return result;
}
// Static desktop review only. Capture is stopped before exposing the two owned
// windows to a screenshot, so this cannot feed a sampled widget back into itself.
// This entrypoint is absent from the shipped native module.
napi_value Review(napi_env env,napi_callback_info info){
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);
    bool value=false;if(n)napi_get_value_bool(env,args[0],&value);frozen=value;
    if(owner&&glass){HWND surface=DG_GetCompositionWindow(glass);
        if(value){if(timer){KillTimer(nullptr,timer);timer=0;}SetWindowDisplayAffinity(owner,WDA_NONE);SetWindowDisplayAffinity(surface,WDA_NONE);}
        else{DG_ExcludeWindowFromCapture(owner);DG_ExcludeWindowFromCapture(surface);timer=SetTimer(nullptr,0,frameInterval,Frame);}
    }return Undefined(env);
}
#endif
void Cleanup(void*){Stop();}
}
NAPI_MODULE_INIT(){
    const napi_property_descriptor methods[]={{"start",nullptr,Start},{"stop",nullptr,End},{"options",nullptr,Options},{"drag",nullptr,Drag},{"stats",nullptr,Stats}};
    napi_define_properties(env,exports,sizeof(methods)/sizeof(methods[0]),methods);napi_add_env_cleanup_hook(env,Cleanup,nullptr);
#ifdef ASS_GLASS_REVIEW
    const napi_property_descriptor review={"review",nullptr,Review};napi_define_properties(env,exports,1,&review);
    const napi_property_descriptor origin={"reviewOrigin",nullptr,ReviewOrigin};napi_define_properties(env,exports,1,&origin);
#endif
    return exports;
}
