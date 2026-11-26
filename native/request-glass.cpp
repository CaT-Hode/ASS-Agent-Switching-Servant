#include <node_api.h>
#include "desktop-glass/DesktopGlass.h"
#include <dwmapi.h>
#include <roapi.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <string>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace {
struct DpiScope {
    DPI_AWARENESS_CONTEXT previous=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    ~DpiScope(){if(previous)SetThreadDpiAwarenessContext(previous);}
};

HWND owner=nullptr;DG_Handle glass=nullptr;HMONITOR monitor=nullptr;
HWND wakeWindow=nullptr;
UINT_PTR retryTimer=0;
constexpr UINT msgSyncGeometry=WM_APP+17;
constexpr UINT msgRebind=WM_APP+18;
constexpr int cursorSettleMs=16,wgcSettleMs=45,dxgiIdleIntervalMs=16,wgcIdleIntervalMs=60;

// Shared state between Electron UI thread (options/drag/rebind) and dedicated glassThread.
std::mutex stateMutex;
float radius=36,inset=6,targetWidth=0,targetHeight=0,heatHeight=43;
float visualWidth=0,visualHeight=0,widthVelocity=0,heightVelocity=0;
float jellyPressure=0,jellyPressureVel=0,pressTarget=0,jellyStretchY=0,jellyStretchYVel=0;
float rowHeight=27,contentInset=10,sectionGap=4,heatBottom=10,summaryHeight=0;
int requestRows=0;
int capacityW=0,capacityH=0,anchorBottom=0;
int lastX=0,lastY=0,lastW=0,lastH=0,lastPad=0;
bool dragging=false,moving=false,reduced=false;
POINT grip{},targetOrigin{};
ULONGLONG lastStepTick=0;
uint64_t creates=0,moves=0;
HRESULT failure=S_OK;
DG_Stats cachedStats{};

// Pending UI geometry sync (posted ONLY when window moves/resizes or first frame reveals).
struct SyncRect {int x=0,y=0,w=0,h=0,pad=0;};
std::mutex syncMutex;
SyncRect pendingSync{};
std::atomic_bool syncPosted{false},revealed{false},rebindPosted{false};
std::atomic<HMONITOR> requestedMonitor{nullptr};
std::atomic<HRESULT> workerError{S_OK};
std::atomic<int> reportedPacerMs{wgcIdleIntervalMs};
std::atomic<ULONGLONG> lastPresentedTick{0};

// Single dedicated native glass worker thread: runs completely off Electron's UI thread
// when stationary (0 PostMessage to UI thread, 0 interference with 1s content updates).
std::thread glassThread;
HANDLE wakeEvent=nullptr,waitTimer=nullptr;
std::atomic_bool workerStopping{false};

#ifdef ASS_GLASS_REVIEW
bool frozen=false,samplingPaused=false;
double geometryMs=0;
std::atomic<int> renderDelayMs{0};
std::mutex reviewMutex;
std::condition_variable reviewDone;
uint64_t reviewReqSeq=0,reviewAckSeq=0;
#endif

void SpringParam(float& value,float& speed,float target,float dt,float stiffness,float damping,float omega){
    if(reduced||(std::abs(value-target)<.05f&&std::abs(speed)<.2f)){value=target;speed=0;return;}
    float offset=value-target,e=std::exp(-damping*dt),c=std::cos(omega*dt),s=std::sin(omega*dt);
    value=target+e*(offset*c+(speed+damping*offset)*s/omega);
    speed=e*(speed*c-(damping*speed+stiffness*offset)*s/omega);
}
void ElasticSpring(float& value,float& speed,float target,float dt,float stiffness,float damping,float omega){
    if(reduced||(std::abs(value-target)<.002f&&std::abs(speed)<.01f)){value=target;speed=0;return;}
    float offset=value-target,e=std::exp(-damping*dt),c=std::cos(omega*dt),s=std::sin(omega*dt);
    value=target+e*(offset*c+(speed+damping*offset)*s/omega);
    speed=e*(speed*c-(damping*speed+stiffness*offset)*s/omega);
}

void SignalWorker(){if(wakeEvent)SetEvent(wakeEvent);}

void StopWorker(){
    if(glass)DG_SetFrameWakeEvent(glass,nullptr);
    workerStopping.store(true,std::memory_order_release);
    SignalWorker();
    if(glassThread.joinable())glassThread.join();
    if(waitTimer){CloseHandle(waitTimer);waitTimer=nullptr;}
    if(wakeEvent){CloseHandle(wakeEvent);wakeEvent=nullptr;}
    syncPosted.store(false,std::memory_order_release);
    rebindPosted.store(false,std::memory_order_release);
}

void PostRebind(HMONITOR nextMon,HRESULT err){
    if(FAILED(err))workerError.store(err,std::memory_order_release);
    if(nextMon)requestedMonitor.store(nextMon,std::memory_order_release);
    if(wakeWindow&&!rebindPosted.exchange(true,std::memory_order_acq_rel)){
        if(!PostMessageW(wakeWindow,msgRebind,0,0))rebindPosted.store(false,std::memory_order_release);
    }
}

void WorkerLoop(DG_Handle handle,HWND host,HWND wake,HMONITOR initialMonitor){
    DpiScope dpiContext;
    HRESULT comInit=RoInitialize(RO_INIT_MULTITHREADED);
    if(FAILED(comInit)){PostRebind(nullptr,comInit);return;}
    HANDLE handles[2]={wakeEvent,waitTimer};
    bool firstRun=true;
    int syncedX=INT_MIN,syncedY=INT_MIN,syncedW=0,syncedH=0;
    POINT prevCursor{INT_MIN,INT_MIN};
    ULONGLONG lastCursorMoveTick=0;
    bool useVSync=false;
    int sleepMs=cursorSettleMs;

    while(!workerStopping.load(std::memory_order_acquire)){
        if(!firstRun){
            if(useVSync){
                // Lock active drag/jelly (and active DXGI background playback) to monitor VBlank.
                if(FAILED(DwmFlush())){
                    LARGE_INTEGER due{};due.QuadPart=-16LL*10000LL;
                    if(waitTimer)SetWaitableTimer(waitTimer,&due,0,nullptr,nullptr,FALSE);
                    WaitForMultipleObjects(waitTimer?2:1,handles,FALSE,16);
                }
            }else{
                // Push-driven WGC stationary wait: wakes in <0.1ms the instant DWM delivers a
                // new frame via pool.FrameArrived (wakeEvent), with waitTimer only as cursor/settle fallback.
                LARGE_INTEGER due{};due.QuadPart=-LONGLONG(sleepMs)*10000LL;
                if(waitTimer)SetWaitableTimer(waitTimer,&due,0,nullptr,nullptr,FALSE);
                WaitForMultipleObjects(waitTimer?2:1,handles,FALSE,DWORD(sleepMs));
            }
        }
        firstRun=false;
        if(workerStopping.load(std::memory_order_acquire))break;
        if(!IsWindow(host)||!IsWindowVisible(host)){useVSync=false;sleepMs=wgcIdleIntervalMs;continue;}

        float dpi=GetDpiForWindow(host)/96.f;
        if(dpi<=0)dpi=1.f;
        POINT cursor{};GetCursorPos(&cursor);
        ULONGLONG now=GetTickCount64();
        if(cursor.x!=prevCursor.x||cursor.y!=prevCursor.y){
            prevCursor=cursor;
            lastCursorMoveTick=now;
        }

        int x=0,y=0,w=0,h=0,pad=0,capW=0,capH=0;
        DG_Parameters p{};DG_DefaultParameters(&p);
        bool needRebind=false,resizing=false,jelling=false,localDragging=false,localMoving=false;
        bool cursorNear=false,inMotion=false;
        HMONITOR targetMon=initialMonitor;
#ifdef ASS_GLASS_REVIEW
        uint64_t stepReviewSeq=0;
#endif

        {
            std::lock_guard guard(stateMutex);
            pad=int(std::lround(inset*dpi));
            float dt=std::clamp((now-lastStepTick)/1000.f,.001f,.05f);lastStepTick=now;

            // Check physical LBUTTON state BEFORE moving to cursor so releasing the mouse
            // stops immediately at the release point with zero IPC delay or teleportation.
            if(dragging&&!(GetAsyncKeyState(VK_LBUTTON)&0x8000)){
                dragging=false;
                pressTarget=0.f;
                if(!reduced)jellyPressureVel-=2.0f;
            }

            SpringParam(visualWidth,widthVelocity,targetWidth*dpi,dt,440.f,16.f,13.56466f);
            SpringParam(visualHeight,heightVelocity,targetHeight*dpi,dt,420.f,13.0f,15.84298f);
            ElasticSpring(jellyPressure,jellyPressureVel,reduced?0.f:pressTarget,dt,520.f,14.5f,17.5997f);
            float targetStretchY=reduced?0.f:std::clamp(-heightVelocity*.0042f,-4.5f*dpi,4.5f*dpi);
            ElasticSpring(jellyStretchY,jellyStretchYVel,targetStretchY,dt,520.f,16.f,16.248f);

            resizing=std::abs(visualWidth-targetWidth*dpi)>.05f||std::abs(visualHeight-targetHeight*dpi)>.05f||
                std::abs(widthVelocity)>.2f||std::abs(heightVelocity)>.2f;
            jelling=std::abs(jellyPressure-pressTarget)>.003f||std::abs(jellyPressureVel)>.015f||
                std::abs(jellyStretchY)>.05f||std::abs(jellyStretchYVel)>.2f;

            w=int(std::lround(visualWidth))-2*pad;
            h=int(std::lround(visualHeight))-2*pad;
            if(w<1||h<1){useVSync=false;sleepMs=wgcIdleIntervalMs;continue;}

            capW=int(std::ceil((std::max(480.f,targetWidth)+32)*dpi))-2*pad;
            capH=int(std::ceil((std::max(362.f,targetHeight)+48)*dpi))-2*pad;
            if(capW!=capacityW||capH!=capacityH)needRebind=true;

            w=std::clamp(w,1,std::max(1,capacityW));
            h=std::clamp(h,1,std::max(1,capacityH));

            if(dragging){
                x=cursor.x-grip.x;y=cursor.y-grip.y;
                targetOrigin={x,y};anchorBottom=y+h+pad;moving=true;
            }else if(moving){
                x=targetOrigin.x;y=targetOrigin.y;anchorBottom=y+h+pad;moving=false;
            }else{
                x=lastX;y=anchorBottom-h-pad;
            }

            RECT targetRect{x,y,x+w,y+h};
            targetMon=MonitorFromRect(&targetRect,MONITOR_DEFAULTTONEAREST);
            if(targetMon!=initialMonitor)needRebind=true;

            lastX=x;lastY=y;lastW=w;lastH=h;lastPad=pad;
            localDragging=dragging;localMoving=moving;

            p.dpi_scale=dpi;p.corner_radius_dip=radius;
            p.bezel_dip=18;p.thickness_dip=72;p.refraction_strength=.40f;p.tint=.08f;p.highlight_strength=.68f;
            p.pressure=reduced?0.f:std::clamp(jellyPressure,-1.f,1.f);
            p.shape_y_px=reduced?0.f:std::clamp(jellyStretchY,-5.f*dpi,5.f*dpi);

            float reachPx=220.f*dpi;
            cursorNear=cursor.x>=x-reachPx&&cursor.x<=x+w+reachPx&&cursor.y>=y-reachPx&&cursor.y<=y+h+reachPx;
            if(cursorNear){
                p.pointer_screen_x_px=float(cursor.x);p.pointer_screen_y_px=float(cursor.y);p.pointer_presence=1.f;
            }else{
                p.pointer_screen_x_px=float(x+w/2);p.pointer_screen_y_px=float(y+h/2);p.pointer_presence=0.f;
            }
            p.probe_count=3;p.probe_interval=10;
            for(unsigned i=0;i<3;++i)p.probes[i]={w*(.2f+.3f*i),h*.5f};

            if(requestRows){
                float footerPx=(heatBottom+heatHeight+summaryHeight+sectionGap)*dpi;
                float maxRowsPx=std::max(4.f*dpi,h-footerPx-6.f*dpi);
                float rowsHeight=std::min((requestRows*rowHeight-4.f)*dpi,maxRowsPx);
                float rowsTop=std::max(4.f*dpi,h-footerPx-rowsHeight);
                float inner=std::clamp(radius-16.f,0.f,10.f)*dpi;
                constexpr float rowBackingBlurDip=9.f;
                p.materials[p.material_count++]={contentInset*dpi,rowsTop,
                    std::max(1.f,w-2*contentInset*dpi),rowsHeight,1,float(requestRows),0,4*dpi,inner,rowBackingBlurDip*dpi};
            }
            inMotion=localDragging||localMoving||resizing||jelling;
#ifdef ASS_GLASS_REVIEW
            stepReviewSeq=reviewReqSeq;
#endif
        }

        if(needRebind){
            PostRebind(targetMon,S_OK);
            useVSync=false;sleepMs=cursorSettleMs;
            continue;
        }

        bool geomChanged=x!=syncedX||y!=syncedY||w!=syncedW||h!=syncedH;
        bool needReveal=!revealed.load(std::memory_order_acquire);

#ifdef ASS_GLASS_REVIEW
        if(int delay=renderDelayMs.load())std::this_thread::sleep_for(std::chrono::milliseconds(delay));
        if(!samplingPaused){
#endif
            HRESULT hr=DG_RenderPresentViewport(handle,x,y,w,h,&p);
            if(FAILED(hr)){
                PostRebind(nullptr,hr);
                useVSync=false;sleepMs=cursorSettleMs;
                continue;
            }
            if(hr==S_OK){
                lastPresentedTick.store(GetTickCount64(),std::memory_order_relaxed);
                if(needReveal)revealed.store(true,std::memory_order_release);
            }
#ifdef ASS_GLASS_REVIEW
        }
#endif

        // Decide next wait strategy AFTER rendering so fresh WGC/DXGI state determines cadence immediately:
        // - Drag/resize/jelly: lock to DwmFlush() (native monitor refresh rate).
        // - Stationary WGC (backend==2): wait on wakeEvent (pool.FrameArrived wakes in <0.1ms at full
        //   60/75/120Hz for scrolling/video!), using 16ms timer while light/cursor settles and 40ms idle fallback.
        // - Stationary DXGI (backend==1): lock to DwmFlush() during recent activity/near-cursor, 16ms idle check.
        DG_Stats latestStats{};
        uint32_t activeBackend=(DG_TryGetStats(handle,&latestStats)==S_OK)?latestStats.backend:0;
        ULONGLONG afterTick=GetTickCount64();
        bool settling=(afterTick-lastPresentedTick.load(std::memory_order_relaxed))<240;
        bool cursorActive=cursorNear&&((afterTick-lastCursorMoveTick)<250);
        if(inMotion){
            useVSync=true;sleepMs=0;
        }else if(activeBackend==2){
            // On WGC, pool.FrameArrived wakes wakeEvent in <0.1ms on every real desktop frame!
            // Keep timer interval >= 45ms when cursor isn't moving so stale-frame settle timers
            // never race against real incoming frames or clog the flip queue.
            useVSync=false;
            sleepMs=(cursorActive||!revealed.load(std::memory_order_acquire))?cursorSettleMs
                :settling?wgcSettleMs:wgcIdleIntervalMs;
        }else{
            useVSync=settling||cursorActive||!revealed.load(std::memory_order_acquire);
            sleepMs=useVSync?0:dxgiIdleIntervalMs;
        }
        reportedPacerMs.store(useVSync?0:sleepMs,std::memory_order_relaxed);

        // Completely decoupled from Electron UI thread when stationary!
        // Only post a coalesced geometry sync when (x,y,w,h) changed or the first frame needs reveal.
        if(geomChanged||(needReveal&&revealed.load(std::memory_order_acquire))){
            {
                std::lock_guard guard(syncMutex);
                pendingSync={x,y,w,h,pad};
            }
            syncedX=x;syncedY=y;syncedW=w;syncedH=h;
            if(!syncPosted.exchange(true,std::memory_order_acq_rel)){
                if(!PostMessageW(wake,msgSyncGeometry,0,0))syncPosted.store(false,std::memory_order_release);
            }
        }
#ifdef ASS_GLASS_REVIEW
        if(stepReviewSeq){
            std::lock_guard guard(reviewMutex);
            reviewAckSeq=stepReviewSeq;
            reviewDone.notify_all();
        }
#endif
    }
    RoUninitialize();
}

void StartWorker(){
    StopWorker();
    if(!glass||!owner||!wakeWindow)return;
    workerStopping.store(false,std::memory_order_release);
    workerError.store(S_OK,std::memory_order_release);
    requestedMonitor.store(nullptr,std::memory_order_release);
    wakeEvent=CreateEventW(nullptr,FALSE,FALSE,nullptr);
    waitTimer=CreateWaitableTimerExW(nullptr,nullptr,CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,TIMER_ALL_ACCESS);
    if(!waitTimer)waitTimer=CreateWaitableTimerW(nullptr,FALSE,nullptr);
    DG_SetFrameWakeEvent(glass,wakeEvent);
    glassThread=std::thread(WorkerLoop,glass,owner,wakeWindow,monitor);
}

void ReleaseGlass(){
    StopWorker();
    if(glass){DG_Destroy(glass);glass=nullptr;}
    capacityW=capacityH=0;cachedStats={};revealed.store(false,std::memory_order_release);
}

void RebindGlass();
void CALLBACK RetryProc(HWND,UINT,UINT_PTR,DWORD){
    if(retryTimer){KillTimer(nullptr,retryTimer);retryTimer=0;}
    RebindGlass();
}
void ScheduleRetry(){
    if(retryTimer)KillTimer(nullptr,retryTimer);
    retryTimer=SetTimer(nullptr,0,500,RetryProc);
}

void RebindGlass(){
    DpiScope dpiContext;
    if(!IsWindow(owner))return;
    HRESULT err=workerError.exchange(S_OK);
    HMONITOR nextMon=requestedMonitor.exchange(nullptr);
    if(FAILED(err)){
        failure=err;
        ReleaseGlass();
        ScheduleRetry();
        return;
    }
    float dpi=GetDpiForWindow(owner)/96.f;if(dpi<=0)dpi=1.f;
    int pad=0,capW=0,capH=0,x=0,y=0,w=0,h=0;
    {
        std::lock_guard guard(stateMutex);
        pad=int(std::lround(inset*dpi));
        capW=int(std::ceil((std::max(480.f,targetWidth)+32)*dpi))-2*pad;
        capH=int(std::ceil((std::max(362.f,targetHeight)+48)*dpi))-2*pad;
        x=lastX;y=lastY;w=std::clamp(lastW,1,std::max(1,capW));h=std::clamp(lastH,1,std::max(1,capH));
    }
    if(capW<1||capH<1)return;
    RECT rect{x,y,x+w,y+h};
    HMONITOR mon=nextMon?nextMon:MonitorFromRect(&rect,MONITOR_DEFAULTTONEAREST);
    if(!glass||capW!=capacityW||capH!=capacityH){
        ReleaseGlass();
        HRESULT hr=DG_Create(owner,capW,capH,&glass);
        if(FAILED(hr)){failure=hr;ScheduleRetry();return;}
        {std::lock_guard guard(stateMutex);capacityW=capW;capacityH=capH;++creates;}
        monitor=mon;
        hr=DG_SelectMonitor(glass,monitor,FALSE,TRUE);
        if(FAILED(hr)){failure=hr;ReleaseGlass();ScheduleRetry();return;}
        failure=S_OK;
        StartWorker();
    }else if(mon!=monitor){
        StopWorker();
        HRESULT hr=DG_SelectMonitor(glass,mon,FALSE,TRUE);
        if(FAILED(hr)){failure=hr;ReleaseGlass();ScheduleRetry();return;}
        monitor=mon;failure=S_OK;
        StartWorker();
    }
}

void Stop(){
    if(retryTimer){KillTimer(nullptr,retryTimer);retryTimer=0;}
    {
        std::lock_guard guard(stateMutex);
        dragging=moving=false;
        jellyPressure=jellyPressureVel=pressTarget=jellyStretchY=jellyStretchYVel=0;
    }
    ReleaseGlass();
    if(wakeWindow){DestroyWindow(wakeWindow);wakeWindow=nullptr;}
    owner=nullptr;monitor=nullptr;
}

LRESULT CALLBACK WakeProc(HWND window,UINT message,WPARAM wp,LPARAM lp){
    if(message==msgSyncGeometry){
        SyncRect rect{};
        {std::lock_guard guard(syncMutex);rect=pendingSync;}
        if(owner&&glass){
            DpiScope dpiContext;
#ifdef ASS_GLASS_REVIEW
            auto t0=std::chrono::steady_clock::now();
#endif
            HRESULT hr=DG_PositionWithOwner(glass,rect.x,rect.y,rect.w,rect.h,rect.pad);
#ifdef ASS_GLASS_REVIEW
            geometryMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count();
#endif
            if(FAILED(hr)){workerError.store(hr,std::memory_order_release);RebindGlass();}
            else{
                DG_EnsurePresentedVisible(glass);
                std::lock_guard guard(stateMutex);++moves;
            }
        }
        // Clear coalescing flag strictly AFTER DeferWindowPos finishes so UI queue never floods.
        syncPosted.store(false,std::memory_order_release);
        return 0;
    }
    if(message==msgRebind){
        rebindPosted.store(false,std::memory_order_release);
#ifdef ASS_GLASS_REVIEW
        if(frozen)return 0;
#endif
        RebindGlass();
        return 0;
    }
    return DefWindowProcW(window,message,wp,lp);
}

napi_value Undefined(napi_env env){napi_value v;napi_get_undefined(env,&v);return v;}
double Number(napi_env env,napi_value object,const char* name,double fallback){
    napi_value v;double value;bool present=false;napi_has_named_property(env,object,name,&present);
    return present&&napi_get_named_property(env,object,name,&v)==napi_ok&&napi_get_value_double(env,v,&value)==napi_ok&&std::isfinite(value)?value:fallback;
}
void Put(napi_env env,napi_value o,const char* key,double value){napi_value v;napi_create_double(env,value,&v);napi_set_named_property(env,o,key,v);}

napi_value Options(napi_env env,napi_callback_info info){
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);
    if(n){
        bool wake=false;
        {
            std::lock_guard guard(stateMutex);
            float prevHeight=targetHeight,prevWidth=targetWidth;
            int prevRows=requestRows;
            radius=float(std::clamp(Number(env,args[0],"radius",radius),8.,48.));
            inset=float(Number(env,args[0],"inset",inset));
            targetWidth=float(Number(env,args[0],"width",targetWidth));
            targetHeight=float(Number(env,args[0],"height",targetHeight));
            requestRows=int(std::clamp(Number(env,args[0],"rows",requestRows),0.,8.));
            // Hidden heatmap height is zero; the widest configured window has 90.2 DIP of heat cells.
            heatHeight=float(std::clamp(Number(env,args[0],"heatHeight",heatHeight),0.,96.));
            summaryHeight=float(std::clamp(Number(env,args[0],"summaryHeight",0.),0.,32.));
            rowHeight=float(std::clamp(Number(env,args[0],"rowHeight",rowHeight),20.,36.));
            contentInset=float(std::clamp(Number(env,args[0],"contentInset",contentInset),4.,24.));
            sectionGap=float(std::clamp(Number(env,args[0],"sectionGap",sectionGap),0.,12.));
            heatBottom=float(std::clamp(Number(env,args[0],"heatBottom",heatBottom),4.,24.));
            reduced=Number(env,args[0],"reducedMotion",reduced?1:0)!=0;
            float deltaH=targetHeight-prevHeight;
            if(owner&&prevHeight>0&&std::abs(deltaH)>=1.f){
                if(!reduced){
                    float mag=std::clamp(std::abs(deltaH)/27.f,.5f,2.2f);
                    jellyPressureVel+=(deltaH>0?-5.8f:5.2f)*mag;
                }
                wake=true;
            }else if(owner&&(requestRows!=prevRows||(prevWidth>0&&std::abs(targetWidth-prevWidth)>=1.f))){
                wake=true;
            }
        }
        if(wake)SignalWorker();
    }
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
    RECT client{};GetClientRect(owner,&client);float dpi=GetDpiForWindow(owner)/96.f;if(dpi<=0)dpi=1.f;
    POINT origin{};ClientToScreen(owner,&origin);
    {
        std::lock_guard guard(stateMutex);
        int pad=int(std::lround(inset*dpi));
        anchorBottom=origin.y+client.bottom;
        visualWidth=float(client.right);visualHeight=float(client.bottom);widthVelocity=heightVelocity=0;
        jellyPressure=jellyPressureVel=pressTarget=jellyStretchY=jellyStretchYVel=0;
        if(targetWidth<=0)targetWidth=visualWidth/dpi;
        if(targetHeight<=0)targetHeight=visualHeight/dpi;
        lastX=origin.x+pad;lastY=origin.y+pad;
        lastW=std::max(1,int(std::lround(visualWidth))-2*pad);
        lastH=std::max(1,int(std::lround(visualHeight))-2*pad);
        lastPad=pad;
        lastStepTick=GetTickCount64();
        lastPresentedTick.store(lastStepTick,std::memory_order_relaxed);
    }
    failure=S_OK;
    RebindGlass();
    return Undefined(env);
}

napi_value End(napi_env env,napi_callback_info){Stop();return Undefined(env);}

napi_value Drag(napi_env env,napi_callback_info){
    DpiScope dpiContext;
#ifdef ASS_GLASS_REVIEW
    if(frozen)return Undefined(env);
#endif
    if(owner&&(GetAsyncKeyState(VK_LBUTTON)&0x8000)){
        POINT cursor{},origin{};GetCursorPos(&cursor);ClientToScreen(owner,&origin);float dpi=GetDpiForWindow(owner)/96.f;if(dpi<=0)dpi=1.f;
        {
            std::lock_guard guard(stateMutex);
            int pad=int(std::lround(inset*dpi));
            grip={cursor.x-origin.x-pad,cursor.y-origin.y-pad};
            dragging=true;pressTarget=reduced?0.f:.22f;
        }
        SignalWorker();
    }
    return Undefined(env);
}

napi_value EndDrag(napi_env env,napi_callback_info){
    bool wake=false;
    {
        std::lock_guard guard(stateMutex);
        if(dragging){
            dragging=false;
            if(!reduced)jellyPressureVel-=2.0f;
            wake=true;
        }
        pressTarget=0.f;
    }
    if(wake)SignalWorker();
    return Undefined(env);
}

napi_value Stats(napi_env env,napi_callback_info){
    DpiScope dpiContext;
    if(glass)DG_TryGetStats(glass,&cachedStats);
    DG_Stats s=cachedStats;
    uint64_t localCreates=0,localMoves=0;bool localDragging=false;int localAnchorBottom=0;
    {
        std::lock_guard guard(stateMutex);
        localCreates=creates;localMoves=moves;localDragging=dragging;localAnchorBottom=anchorBottom;
    }
    napi_value result;napi_create_object(env,&result);
    Put(env,result,"submitted",double(s.submitted));Put(env,result,"presented",double(s.presented));Put(env,result,"captured",double(s.captured));
    Put(env,result,"backend",s.backend);Put(env,result,"error",static_cast<unsigned long>(failure));
    Put(env,result,"lastCaptureError",static_cast<unsigned long>(s.last_capture_error));
    Put(env,result,"captureMs",s.capture_ms);Put(env,result,"gpuMs",s.gpu_ms);Put(env,result,"readbackBytes",double(s.probe_readback_bytes));
    Put(env,result,"renderToPresentMs",s.render_to_present_ms);Put(env,result,"sourceAgeMs",s.source_age_ms);
    Put(env,result,"luminance",(s.probe_luminance[0]+s.probe_luminance[1]+s.probe_luminance[2])/3.);
    Put(env,result,"creates",double(localCreates));Put(env,result,"moves",double(localMoves));
    Put(env,result,"dragging",localDragging?1:0);
    Put(env,result,"x",s.presented_x_px);Put(env,result,"y",s.presented_y_px);
    Put(env,result,"width",s.presented_width_px);Put(env,result,"height",s.presented_height_px);
    Put(env,result,"lightHistoryResets",double(s.light_history_resets));
    Put(env,result,"pacerMs",double(reportedPacerMs.load(std::memory_order_relaxed)));
#ifdef ASS_GLASS_REVIEW
    if(owner){POINT origin{};RECT client{},surface{};ClientToScreen(owner,&origin);GetClientRect(owner,&client);
        int pad=int(std::lround(inset*GetDpiForWindow(owner)/96.f));
        Put(env,result,"ownerX",origin.x+pad);Put(env,result,"ownerY",origin.y+pad);
        Put(env,result,"ownerBottom",origin.y+client.bottom);Put(env,result,"ownerHeight",client.bottom);
        Put(env,result,"anchorBottom",localAnchorBottom);
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
napi_value ReviewSampling(napi_env env,napi_callback_info info){
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);
    if(n)napi_get_value_bool(env,args[0],&samplingPaused);return Undefined(env);
}
napi_value ReviewOrigin(napi_env env,napi_callback_info info){
    DpiScope dpiContext;
    size_t n=2;napi_value args[2];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);int32_t x=0,y=0;
    if(n<2||napi_get_value_int32(env,args[0],&x)!=napi_ok||napi_get_value_int32(env,args[1],&y)!=napi_ok)return Undefined(env);
    if(owner&&!frozen){
        uint64_t targetSeq=0;
        {std::lock_guard guard(stateMutex);targetOrigin={x,y};moving=true;targetSeq=++reviewReqSeq;}
        SignalWorker();
        {std::unique_lock guard(reviewMutex);reviewDone.wait_for(guard,std::chrono::milliseconds(25),[&]{return reviewAckSeq>=targetSeq;});}
        // Apply pending geometry immediately for test inspection.
        if(glass){
            SyncRect r{};{std::lock_guard guard(syncMutex);r=pendingSync;}
            if(r.w>0&&r.h>0){
                auto t0=std::chrono::steady_clock::now();
                DG_PositionWithOwner(glass,r.x,r.y,r.w,r.h,r.pad);
                geometryMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count();
            }
        }
    }
    napi_value result=Stats(env,info);POINT point{};if(owner)ClientToScreen(owner,&point);
    int pad=owner?int(std::lround(inset*GetDpiForWindow(owner)/96.f)):0;
    Put(env,result,"ownerX",point.x+pad);Put(env,result,"ownerY",point.y+pad);return result;
}
napi_value Review(napi_env env,napi_callback_info info){
    size_t n=1;napi_value args[1];napi_get_cb_info(env,info,&n,args,nullptr,nullptr);
    bool value=false;if(n)napi_get_value_bool(env,args[0],&value);frozen=value;
    if(owner&&glass){HWND surface=DG_GetCompositionWindow(glass);
        if(value){StopWorker();SetWindowDisplayAffinity(owner,WDA_NONE);SetWindowDisplayAffinity(surface,WDA_NONE);}
        else{DG_ExcludeWindowFromCapture(owner);DG_ExcludeWindowFromCapture(surface);StartWorker();}
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
