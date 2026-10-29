#include <node_api.h>
#include "desktop-glass/DesktopGlass.h"
#include <dwmapi.h>
#include <roapi.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#ifdef ASS_GLASS_REVIEW
#include <chrono>
#endif

namespace {
struct DpiScope {
    DPI_AWARENESS_CONTEXT previous=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    ~DpiScope(){if(previous)SetThreadDpiAwarenessContext(previous);}
};
HWND owner=nullptr;DG_Handle glass=nullptr;HMONITOR monitor=nullptr;
UINT_PTR timer=0;ULONGLONG retryAt=0,lastTick=0;int width=0,height=0,anchorBottom=0;
float radius=36,inset=10,targetWidth=0,targetHeight=0,visualWidth=0,visualHeight=0,widthVelocity=0,heightVelocity=0;
int requestRows=0;bool dragging=false,moving=false,reduced=false;
POINT grip{},targetOrigin{};HRESULT failure=S_OK;
uint64_t creates=0,moves=0;
// WM_TIMER rounds to the system tick: 30/10 ms target about 30/60 Hz
// without requesting a higher system-wide timer resolution.
constexpr UINT idleInterval=30,motionInterval=10;
UINT scheduledInterval=0;
HWND wakeWindow=nullptr;
constexpr UINT frameReady=WM_APP+17;
struct RenderJob {int x=0,y=0,w=0,h=0;DG_Parameters parameters{};};
RenderJob latestJob{};std::mutex jobMutex;std::condition_variable jobReady;
std::thread renderThread;bool stopping=false,jobPending=false;
std::atomic<HRESULT> renderError{S_OK};DG_Stats cachedStats{};
#ifdef ASS_GLASS_REVIEW
bool frozen=false,samplingPaused=false;double geometryMs=0;std::atomic<int> renderDelayMs{0};
#endif

void StopRenderer(){
    {std::lock_guard guard(jobMutex);stopping=true;jobPending=false;}jobReady.notify_one();
    if(renderThread.joinable())renderThread.join();
}
void StartRenderer(){
    {std::lock_guard guard(jobMutex);stopping=false;jobPending=false;}renderError=S_OK;
    auto handle=glass;auto wake=wakeWindow;
    renderThread=std::thread([handle,wake]{
        HRESULT initialized=RoInitialize(RO_INIT_MULTITHREADED);
        if(FAILED(initialized)){renderError=initialized;return;}
        for(;;){RenderJob job;
            {std::unique_lock guard(jobMutex);jobReady.wait(guard,[]{return stopping||jobPending;});
                if(stopping)break;job=latestJob;jobPending=false;}
#ifdef ASS_GLASS_REVIEW
            if(int delay=renderDelayMs.load())std::this_thread::sleep_for(std::chrono::milliseconds(delay));
#endif
            HRESULT hr=DG_RenderViewport(handle,job.x,job.y,job.w,job.h,&job.parameters);
            if(FAILED(hr))renderError=hr;
            PostMessageW(wake,frameReady,0,0);
        }
        RoUninitialize();
    });
}
void Release(){StopRenderer();if(glass){DG_Destroy(glass);glass=nullptr;}width=height=0;cachedStats={};}
void Stop(){if(timer){KillTimer(nullptr,timer);timer=0;}scheduledInterval=0;dragging=moving=false;Release();
    if(wakeWindow){DestroyWindow(wakeWindow);wakeWindow=nullptr;}owner=nullptr;}
void Fail(HRESULT hr){failure=hr;Release();retryAt=GetTickCount64()+500;}
LRESULT CALLBACK WakeProc(HWND window,UINT message,WPARAM wp,LPARAM lp){
    if(message==frameReady){
#ifdef ASS_GLASS_REVIEW
        if(samplingPaused||frozen)return 0;
#endif
        if(owner&&glass){HRESULT hr=DG_Present(glass);if(FAILED(hr))Fail(hr);
            else if(hr==S_OK){failure=S_OK;DG_TryGetStats(glass,&cachedStats);}}
        return 0;
    }
    return DefWindowProcW(window,message,wp,lp);
}
void Spring(float& value,float& speed,float target,float dt){
    if(reduced||std::abs(value-target)<.05f&&std::abs(speed)<.2f){value=target;speed=0;return;}
    constexpr float damping=17,omega=14.52584f,stiffness=500;
    float offset=value-target,e=std::exp(-damping*dt),c=std::cos(omega*dt),s=std::sin(omega*dt);
    value=target+e*(offset*c+(speed+damping*offset)*s/omega);
    speed=e*(speed*c-(damping*speed+stiffness*offset)*s/omega);
}
void CALLBACK Frame(HWND,UINT,UINT_PTR,DWORD);
void Schedule(UINT interval){
    if(timer&&scheduledInterval==interval)return;
    if(timer)KillTimer(nullptr,timer);
    timer=SetTimer(nullptr,0,interval,Frame);scheduledInterval=interval;
}
void CALLBACK Frame(HWND,UINT,UINT_PTR,DWORD){
    DpiScope dpiContext;
    if(!IsWindow(owner)||!IsWindowVisible(owner))return;
    if(GetTickCount64()<retryAt)return;
    HRESULT backgroundError=renderError.exchange(S_OK);if(FAILED(backgroundError)){Fail(backgroundError);return;}
    RECT client{};POINT origin{};GetClientRect(owner,&client);ClientToScreen(owner,&origin);
    float dpi=GetDpiForWindow(owner)/96.f;int pad=int(std::lround(inset*dpi));
    POINT cursor{};GetCursorPos(&cursor);int x=origin.x+pad,y=origin.y+pad;
    ULONGLONG now=GetTickCount64();float dt=std::clamp((now-lastTick)/1000.f,.001f,.05f);lastTick=now;
    Spring(visualWidth,widthVelocity,targetWidth*dpi,dt);Spring(visualHeight,heightVelocity,targetHeight*dpi,dt);
    bool resizing=std::abs(visualWidth-targetWidth*dpi)>.05f||std::abs(visualHeight-targetHeight*dpi)>.05f||
        std::abs(widthVelocity)>.2f||std::abs(heightVelocity)>.2f;
    Schedule(dragging||moving||resizing?motionInterval:idleInterval);
    int w=int(std::lround(visualWidth))-2*pad,h=int(std::lround(visualHeight))-2*pad;if(w<1||h<1)return;
    if(dragging){
        x=cursor.x-grip.x;y=cursor.y-grip.y;
        targetOrigin={x,y};anchorBottom=y+h+pad;moving=true;
        if(!(GetAsyncKeyState(VK_LBUTTON)&0x8000))dragging=false;
    }
    else if(moving){x=targetOrigin.x;y=targetOrigin.y;anchorBottom=y+h+pad;}
    else y=anchorBottom-h-pad;
    RECT target{x,y,x+w,y+h};HMONITOR current=MonitorFromRect(&target,MONITOR_DEFAULTTONEAREST);
    int capacityWidth=int(std::ceil((std::max(640.f,targetWidth)+32)*dpi))-2*pad;
    int capacityHeight=int(std::ceil((std::max(362.f,targetHeight)+32)*dpi))-2*pad;
    if(!glass||capacityWidth!=width||capacityHeight!=height){
        Release();HRESULT hr=DG_Create(owner,capacityWidth,capacityHeight,&glass);if(FAILED(hr)){Fail(hr);return;}
        width=capacityWidth;height=capacityHeight;monitor=current;++creates;
        hr=DG_SelectMonitor(glass,monitor,FALSE,TRUE);if(FAILED(hr)){Fail(hr);return;}
        StartRenderer();
    }else if(current!=monitor){
        StopRenderer();HRESULT hr=DG_SelectMonitor(glass,current,FALSE,TRUE);if(FAILED(hr)){Fail(hr);return;}monitor=current;StartRenderer();
    }
    DG_Parameters p{};DG_DefaultParameters(&p);p.dpi_scale=dpi;p.corner_radius_dip=radius;
    p.bezel_dip=19;p.thickness_dip=72;p.refraction_strength=.54f;p.tint=.08f;p.highlight_strength=.64f;
    p.pointer_screen_x_px=float(cursor.x);p.pointer_screen_y_px=float(cursor.y);p.pointer_presence=1;
    p.probe_count=3;p.probe_interval=10;
    for(unsigned i=0;i<3;++i)p.probes[i]={w*(.2f+.3f*i),h*.5f};
    float inner=std::clamp(radius-16.f,0.f,10.f)*dpi;
    if(requestRows){float rowsHeight=(requestRows*29-4)*dpi;
        p.materials[p.material_count++]={16*dpi,h-78*dpi-rowsHeight,w-32*dpi,rowsHeight,1,float(requestRows),0,4*dpi,inner,2.8f*dpi};}
    p.materials[p.material_count++]={16*dpi,h-68*dpi,w-32*dpi,52*dpi,12,2,4*dpi,4*dpi,5*dpi,3.2f*dpi};
    // Geometry is committed before capture/presentation. Empty or busy GPU
    // frames no longer hold back foreground input or bottom-anchored sizing.
#ifdef ASS_GLASS_REVIEW
    auto geometryStart=std::chrono::steady_clock::now();
#endif
    HRESULT hr=DG_PositionWithOwner(glass,x,y,w,h,pad);if(FAILED(hr)){Fail(hr);return;}
#ifdef ASS_GLASS_REVIEW
    geometryMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-geometryStart).count();
#endif
    if(origin.x+pad!=x||origin.y+pad!=y||client.right!=w+2*pad||client.bottom!=h+2*pad)++moves;
    if(!dragging)moving=false;
#ifdef ASS_GLASS_REVIEW
    if(samplingPaused)return;
#endif
    {std::lock_guard guard(jobMutex);latestJob={x,y,w,h,p};jobPending=true;}jobReady.notify_one();
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
    DpiScope dpiContext;
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);void* bytes=nullptr;size_t size=0;
    if(!n||napi_get_buffer_info(env,args[0],&bytes,&size)!=napi_ok||size<sizeof(HWND)){napi_throw_error(env,nullptr,"Invalid widget window handle");return nullptr;}
    Stop();std::memcpy(&owner,bytes,sizeof(HWND));
    if(!IsWindow(owner)||GetWindowThreadProcessId(owner,nullptr)!=GetCurrentThreadId()){
        owner=nullptr;napi_throw_error(env,nullptr,"Glass must attach on the widget UI thread");return nullptr;}
    HRESULT hr=DG_ExcludeWindowFromCapture(owner);if(FAILED(hr)){owner=nullptr;napi_throw_error(env,nullptr,"Could not exclude widget from desktop capture");return nullptr;}
    int corners=1;DwmSetWindowAttribute(owner,33,&corners,sizeof(corners));
    WNDCLASSW wc{};wc.lpfnWndProc=WakeProc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"ASSGlassFrameReady";
    if(!RegisterClassW(&wc)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS){Stop();napi_throw_error(env,nullptr,"Glass wake window registration failed");return nullptr;}
    wakeWindow=CreateWindowExW(0,wc.lpszClassName,L"",0,0,0,0,0,HWND_MESSAGE,nullptr,wc.hInstance,nullptr);
    if(!wakeWindow){Stop();napi_throw_error(env,nullptr,"Glass wake window creation failed");return nullptr;}
    BOOL animations=TRUE;if(SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&animations,0))reduced=!animations;
    RECT client{};GetClientRect(owner,&client);float dpi=GetDpiForWindow(owner)/96.f;
    POINT origin{};ClientToScreen(owner,&origin);anchorBottom=origin.y+client.bottom;
    visualWidth=float(client.right);visualHeight=float(client.bottom);widthVelocity=heightVelocity=0;
    if(targetWidth<=0)targetWidth=visualWidth/dpi;if(targetHeight<=0)targetHeight=visualHeight/dpi;
    failure=S_OK;retryAt=0;lastTick=GetTickCount64();Schedule(idleInterval);Frame(nullptr,0,0,0);
    return Undefined(env);
}
napi_value End(napi_env env,napi_callback_info){Stop();return Undefined(env);}
napi_value Drag(napi_env env,napi_callback_info){
    DpiScope dpiContext;
#ifdef ASS_GLASS_REVIEW
    if(frozen)return Undefined(env);
#endif
    if(owner){POINT cursor{},origin{};GetCursorPos(&cursor);ClientToScreen(owner,&origin);float dpi=GetDpiForWindow(owner)/96.f;
        int pad=int(std::lround(inset*dpi));grip={cursor.x-origin.x-pad,cursor.y-origin.y-pad};dragging=true;Schedule(motionInterval);Frame(nullptr,0,0,0);}
    return Undefined(env);
}
napi_value EndDrag(napi_env env,napi_callback_info){if(dragging)Frame(nullptr,0,0,0);dragging=false;return Undefined(env);}
napi_value Stats(napi_env env,napi_callback_info){
    DpiScope dpiContext;
    if(glass)DG_TryGetStats(glass,&cachedStats);DG_Stats s=cachedStats;napi_value result;napi_create_object(env,&result);
    Put(env,result,"submitted",double(s.submitted));Put(env,result,"presented",double(s.presented));Put(env,result,"captured",double(s.captured));
    Put(env,result,"backend",s.backend);Put(env,result,"error",static_cast<unsigned long>(failure));
    Put(env,result,"captureMs",s.capture_ms);Put(env,result,"gpuMs",s.gpu_ms);Put(env,result,"readbackBytes",double(s.probe_readback_bytes));
    Put(env,result,"renderToPresentMs",s.render_to_present_ms);Put(env,result,"sourceAgeMs",s.source_age_ms);
    Put(env,result,"luminance",(s.probe_luminance[0]+s.probe_luminance[1]+s.probe_luminance[2])/3.);
    Put(env,result,"creates",double(creates));Put(env,result,"moves",double(moves));
    Put(env,result,"dragging",dragging?1:0);
    Put(env,result,"x",s.presented_x_px);Put(env,result,"y",s.presented_y_px);
    Put(env,result,"width",s.presented_width_px);Put(env,result,"height",s.presented_height_px);
    Put(env,result,"lightHistoryResets",double(s.light_history_resets));
#ifdef ASS_GLASS_REVIEW
    if(owner){POINT origin{};RECT client{},surface{};ClientToScreen(owner,&origin);GetClientRect(owner,&client);
        int pad=int(std::lround(inset*GetDpiForWindow(owner)/96.f));
        Put(env,result,"ownerX",origin.x+pad);Put(env,result,"ownerY",origin.y+pad);
        Put(env,result,"ownerBottom",origin.y+client.bottom);Put(env,result,"ownerHeight",client.bottom);
        Put(env,result,"anchorBottom",anchorBottom);
        if(glass){GetWindowRect(DG_GetCompositionWindow(glass),&surface);
            Put(env,result,"surfaceX",surface.left);Put(env,result,"surfaceY",surface.top);
            Put(env,result,"surfaceTopmost",(GetWindowLongPtrW(DG_GetCompositionWindow(glass),GWL_EXSTYLE)&WS_EX_TOPMOST)!=0);}
        Put(env,result,"ownerTopmost",(GetWindowLongPtrW(owner,GWL_EXSTYLE)&WS_EX_TOPMOST)!=0);
        Put(env,result,"geometryMs",geometryMs);}
#endif
    return result;
}
#ifdef ASS_GLASS_REVIEW
napi_value ReviewDelay(napi_env env,napi_callback_info info){
    size_t n=1;napi_value args[1];int32_t value=0;napi_get_cb_info(env,info,&n,args,nullptr,nullptr);
    if(n&&napi_get_value_int32(env,args[0],&value)==napi_ok)renderDelayMs=std::clamp(value,0,250);return Undefined(env);
}
// Pause only the isolated test renderer; exercise foreground geometry while
// background submission is unavailable. Never included in production exports.
napi_value ReviewSampling(napi_env env,napi_callback_info info){
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);
    if(n)napi_get_value_bool(env,args[0],&samplingPaused);return Undefined(env);
}
// Drives only the isolated test host through the real render/present path.
// It does not synthesize OS mouse input and is absent from the shipped module.
napi_value ReviewOrigin(napi_env env,napi_callback_info info){
    DpiScope dpiContext;
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
        if(value){if(timer){KillTimer(nullptr,timer);timer=0;}StopRenderer();SetWindowDisplayAffinity(owner,WDA_NONE);SetWindowDisplayAffinity(surface,WDA_NONE);}
        else{DG_ExcludeWindowFromCapture(owner);DG_ExcludeWindowFromCapture(surface);StartRenderer();Schedule(idleInterval);}
    }return Undefined(env);
}
#endif
void Cleanup(void*){Stop();}
}
NAPI_MODULE_INIT(){
    const napi_property_descriptor methods[]={{"start",nullptr,Start},{"stop",nullptr,End},{"options",nullptr,Options},{"drag",nullptr,Drag},{"endDrag",nullptr,EndDrag},{"stats",nullptr,Stats}};
    napi_define_properties(env,exports,sizeof(methods)/sizeof(methods[0]),methods);napi_add_env_cleanup_hook(env,Cleanup,nullptr);
#ifdef ASS_GLASS_REVIEW
    const napi_property_descriptor review={"review",nullptr,Review};napi_define_properties(env,exports,1,&review);
    const napi_property_descriptor origin={"reviewOrigin",nullptr,ReviewOrigin};napi_define_properties(env,exports,1,&origin);
    const napi_property_descriptor sampling={"reviewSampling",nullptr,ReviewSampling};napi_define_properties(env,exports,1,&sampling);
    const napi_property_descriptor delay={"reviewDelay",nullptr,ReviewDelay};napi_define_properties(env,exports,1,&delay);
#endif
    return exports;
}
