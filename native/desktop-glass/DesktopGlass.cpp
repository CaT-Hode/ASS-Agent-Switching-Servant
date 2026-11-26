#include "DesktopGlass.h"
#include "GlassShader.h"
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dxgi1_5.h>
#include <dcomp.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using namespace winrt::Windows::Graphics::Capture;
using winrt::Windows::Foundation::Metadata::ApiInformation;
using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
namespace {
thread_local std::string diagnostic;
double Now(){LARGE_INTEGER c,f;QueryPerformanceCounter(&c);QueryPerformanceFrequency(&f);return double(c.QuadPart)/double(f.QuadPart);}
double QpcTime(LONGLONG c){LARGE_INTEGER f;QueryPerformanceFrequency(&f);return c>0?double(c)/double(f.QuadPart):Now();}
template<class F> HRESULT Boundary(F&& call) noexcept {
    try{return call();}
    catch(winrt::hresult_error const& e){diagnostic=winrt::to_string(e.message());return e.code();}
    catch(std::bad_alloc const&){return E_OUTOFMEMORY;}
    catch(...){diagnostic="DesktopGlass operation failed";return E_FAIL;}
}
struct DpiScope {
    DPI_AWARENESS_CONTEXT previous=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    ~DpiScope(){if(previous)SetThreadDpiAwarenessContext(previous);}
};
struct WakeBridge {
    std::mutex mutex;
    HANDLE handle=nullptr;
    void Set(HANDLE source){
        HANDLE dup=nullptr;
        if(source){
            HANDLE proc=GetCurrentProcess();
            if(!DuplicateHandle(proc,source,proc,&dup,0,FALSE,DUPLICATE_SAME_ACCESS))dup=nullptr;
        }
        HANDLE old=nullptr;
        {std::lock_guard guard(mutex);old=handle;handle=dup;}
        if(old)CloseHandle(old);
    }
    void Signal() noexcept {
        std::lock_guard guard(mutex);
        if(handle)SetEvent(handle);
    }
    ~WakeBridge(){Set(nullptr);}
};
struct WgcTile {
    GraphicsCaptureItem item{nullptr};Direct3D11CaptureFramePool pool{nullptr};
    GraphicsCaptureSession capture{nullptr};Direct3D11CaptureFrame held{nullptr};
    ComPtr<ID3D11Texture2D> texture;int width=0,height=0;double timestamp=0;
    bool dirtyRegionsEnabled=false;
    std::shared_ptr<std::atomic_bool> closed=std::make_shared<std::atomic_bool>(false);
    winrt::event_token closedToken{},arrivedToken{};bool subscribed=false,arrivedSubscribed=false;
    ~WgcTile(){
        try{if(arrivedSubscribed&&pool)pool.FrameArrived(arrivedToken);}catch(...){}
        try{if(subscribed)item.Closed(closedToken);}catch(...){}
        texture.Reset();try{if(held)held.Close();if(capture)capture.Close();if(pool)pool.Close();}catch(...){}
    }
    void Init(GraphicsCaptureItem source,winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice bridge,
        std::shared_ptr<WakeBridge> wake){
        item=source;auto size=item.Size();width=size.Width;height=size.Height;
        if(width<1||height<1)winrt::throw_hresult(E_BOUNDS);
        closedToken=item.Closed([flag=closed](auto const&,auto const&)noexcept{flag->store(true);});subscribed=true;
        pool=Direct3D11CaptureFramePool::CreateFreeThreaded(bridge,DirectXPixelFormat::B8G8R8A8UIntNormalized,2,size);
        if(wake){
            arrivedToken=pool.FrameArrived([wake=std::move(wake)](Direct3D11CaptureFramePool const&,winrt::Windows::Foundation::IInspectable const&)noexcept{
                wake->Signal();
            });
            arrivedSubscribed=true;
        }
        capture=pool.CreateCaptureSession(item);capture.IsCursorCaptureEnabled(false);
        // Enable Win11 24H2 DirtyRegions reporting (ReportOnly keeps full-monitor surface fresh
        // while letting us skip GPU passes when changes happen outside the widget ROI).
        try{
            if(ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession",L"DirtyRegionMode")&&
               ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.Direct3D11CaptureFrame",L"DirtyRegions")){
                capture.DirtyRegionMode(GraphicsCaptureDirtyRegionMode::ReportOnly);
                dirtyRegionsEnabled=true;
            }
        }catch(...){dirtyRegionsEnabled=false;}
        // Leave the system capture indicator and access policy to Windows.
        capture.StartCapture();
    }
    bool FrameIntersectsRoi(Direct3D11CaptureFrame const& frame,RECT const& localRegion) const {
        if(!dirtyRegionsEnabled)return true;
        try{
            auto regions=frame.DirtyRegions();
            if(!regions||regions.Size()==0)return false;
            for(auto const& r:regions){
                RECT dr{r.X,r.Y,r.X+r.Width,r.Y+r.Height},hit{};
                if(IntersectRect(&hit,&dr,&localRegion))return true;
            }
            return false;
        }catch(...){return true;}
    }
    bool Update(uint64_t& count,RECT const& localRegion,bool& roiHit){
        roiHit=false;
        if(closed->load())winrt::throw_hresult(RO_E_CLOSED);
        auto frame=pool.TryGetNextFrame();if(!frame)return texture!=nullptr;
        bool hadTexture=texture!=nullptr;
        bool anyRoiHit=!hadTexture||FrameIntersectsRoi(frame,localRegion);
        while(auto newer=pool.TryGetNextFrame()){
            if(!anyRoiHit)anyRoiHit=FrameIntersectsRoi(newer,localRegion);
            frame.Close();frame=newer;
        }
        auto size=frame.ContentSize();
        if(size.Width<1||size.Height<1){frame.Close();return false;}
        if(size.Width!=width||size.Height!=height){frame.Close();winrt::throw_hresult(DXGI_ERROR_MODE_CHANGE_IN_PROGRESS);}
        texture.Reset();if(held)held.Close();held=frame;
        auto access=held.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(&texture)));
        timestamp=double(held.SystemRelativeTime().count())/1e7;++count;
        roiHit=anyRoiHit;
        return true;
    }
};
struct DxgiTile {
    ComPtr<IDXGIOutputDuplication> duplication;ComPtr<ID3D11Texture2D> texture;
    std::vector<BYTE> metadata;
    int width=0,height=0;double timestamp=0;bool valid=false;
};
LRESULT CALLBACK GlassWndProc(HWND window,UINT message,WPARAM wParam,LPARAM lParam){
    if(message==WM_NCHITTEST)return HTTRANSPARENT;
    if(message==WM_MOUSEACTIVATE)return MA_NOACTIVATE;
    return DefWindowProcW(window,message,wParam,lParam);
}
struct Presenter {
    HWND window=nullptr,owner=nullptr;int width=0,height=0,x=0,y=0;
    std::atomic_bool visible{true},hasFrame{false},shown{false};
    bool hostGeometry=false;
    ComPtr<IDXGISwapChain1> swap;ComPtr<IDCompositionDevice> composition;
    ComPtr<IDCompositionTarget> target;ComPtr<IDCompositionVisual> visual;
    ~Presenter(){if(window)DestroyWindow(window);}
    void Init(ID3D11Device* device,HWND host,int w,int h){
        DpiScope dpi;
        owner=host;width=w;height=h;
        static const wchar_t* name=L"DesktopGlassComposition";
        WNDCLASSEXW wc{};wc.cbSize=sizeof(wc);wc.lpfnWndProc=GlassWndProc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=name;
        if(!RegisterClassExW(&wc)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)winrt::throw_last_error();
        window=CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_TRANSPARENT,
            name,L"",WS_POPUP,0,0,w,h,nullptr,nullptr,wc.hInstance,nullptr);
        if(!window)winrt::throw_last_error();
        winrt::check_bool(SetWindowDisplayAffinity(window,WDA_EXCLUDEFROMCAPTURE));
        ComPtr<IDXGIDevice> dxgi;winrt::check_hresult(device->QueryInterface(IID_PPV_ARGS(&dxgi)));
        winrt::check_hresult(DCompositionCreateDevice(dxgi.Get(),IID_PPV_ARGS(&composition)));
        ComPtr<IDXGIAdapter> adapter;winrt::check_hresult(dxgi->GetAdapter(&adapter));
        ComPtr<IDXGIFactory2> factory;winrt::check_hresult(adapter->GetParent(IID_PPV_ARGS(&factory)));
        DXGI_SWAP_CHAIN_DESC1 desc{};desc.Width=w;desc.Height=h;desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count=1;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.BufferCount=3;
        desc.Scaling=DXGI_SCALING_STRETCH;desc.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;desc.AlphaMode=DXGI_ALPHA_MODE_PREMULTIPLIED;
        winrt::check_hresult(factory->CreateSwapChainForComposition(device,&desc,nullptr,&swap));
        winrt::check_hresult(composition->CreateTargetForHwnd(window,TRUE,&target));
        winrt::check_hresult(composition->CreateVisual(&visual));winrt::check_hresult(visual->SetContent(swap.Get()));
        winrt::check_hresult(target->SetRoot(visual.Get()));winrt::check_hresult(composition->Commit());
    }
    void Position(int sampleX,int sampleY,int w,int h,int ownerInset=-1){
        DpiScope dpi;
        bool ready=hasFrame.load(std::memory_order_acquire)&&visible.load(std::memory_order_acquire);
        bool currentlyVisible=IsWindowVisible(window)!=FALSE;
        bool stackChanged=((GetWindowLongPtrW(window,GWL_EXSTYLE)^GetWindowLongPtrW(owner,GWL_EXSTYLE))&WS_EX_TOPMOST)!=0;
        bool moveSurface=x!=sampleX||y!=sampleY,resizeSurface=width!=w||height!=h;
        bool updateSurface=moveSurface||resizeSurface||stackChanged||(ready&&!currentlyVisible);
        RECT client{};POINT origin{};bool moveOwner=false,resizeOwner=false;
        if(ownerInset>=0){GetClientRect(owner,&client);ClientToScreen(owner,&origin);
            moveOwner=origin.x!=sampleX-ownerInset||origin.y!=sampleY-ownerInset;
            resizeOwner=client.right!=w+2*ownerInset||client.bottom!=h+2*ownerInset;}
        if(updateSurface||moveOwner||resizeOwner){
            HDWP batch=BeginDeferWindowPos(2);winrt::check_bool(batch!=nullptr);
            if(moveOwner||resizeOwner){
                UINT flags=SWP_NOACTIVATE|SWP_NOZORDER|(moveOwner?0:SWP_NOMOVE)|(resizeOwner?0:SWP_NOSIZE);
                batch=DeferWindowPos(batch,owner,nullptr,sampleX-ownerInset,sampleY-ownerInset,w+2*ownerInset,h+2*ownerInset,flags);
                winrt::check_bool(batch!=nullptr);
            }
            if(updateSurface){
                UINT flags=SWP_NOACTIVATE|(moveSurface?0:SWP_NOMOVE)|(resizeSurface?0:SWP_NOSIZE)|
                    (ready?SWP_SHOWWINDOW:0);
                batch=DeferWindowPos(batch,window,owner,sampleX,sampleY,w,h,flags);winrt::check_bool(batch!=nullptr);
            }
            winrt::check_bool(EndDeferWindowPos(batch));
            if(ready)shown.store(true,std::memory_order_release);
        }
        x=sampleX;y=sampleY;width=w;height=h;
    }
    void ShowIfNeeded(){
        if(!hasFrame.load(std::memory_order_acquire)||!visible.load(std::memory_order_acquire))return;
        if(shown.load(std::memory_order_acquire)&&IsWindowVisible(window))return;
        DpiScope dpi;
        SetWindowPos(window,owner,x,y,width,height,SWP_NOACTIVATE|SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW);
        shown.store(true,std::memory_order_release);
    }
    HRESULT PresentBackBuffer(){
        if(!visible.load(std::memory_order_acquire))return S_FALSE;
        HRESULT hr=swap->Present(0,DXGI_PRESENT_DO_NOT_WAIT);
        if(hr==DXGI_ERROR_WAS_STILL_DRAWING)return S_FALSE;
        winrt::check_hresult(hr);
        hasFrame.store(true,std::memory_order_release);
        return S_OK;
    }
    HRESULT Present(ID3D11DeviceContext* context,ID3D11Texture2D* source,int sampleX,int sampleY,int w,int h){
        if(!visible.load(std::memory_order_acquire))return S_FALSE;
        ComPtr<ID3D11Texture2D> back;winrt::check_hresult(swap->GetBuffer(0,IID_PPV_ARGS(&back)));
        context->CopyResource(back.Get(),source);
        HRESULT hr=PresentBackBuffer();
        if(hr!=S_OK)return hr;
        if(!hostGeometry)Position(sampleX,sampleY,w,h);
        else ShowIfNeeded();
        return S_OK;
    }
};
struct Slot {
    ComPtr<ID3D11Texture2D> texture;ComPtr<ID3D11RenderTargetView> target;
    ComPtr<ID3D11Query> done,begin,end,disjoint;
    int state=0,x=0,y=0,width=0,height=0;uint64_t serial=0;double sourceTime=0,gpuMs=0,submittedAt=0;uint32_t probeCount=0;
    bool queryActive=false;
};
struct Piece {
    HMONITOR monitor=nullptr;
    RECT bounds{}, intersection{};
    ID3D11Texture2D* source=nullptr;
};
struct PieceList {
    Piece items[8];
    int count=0;
};
BOOL CALLBACK Enumerate(HMONITOR monitor,HDC,LPRECT,LPARAM data){
    auto* list=reinterpret_cast<PieceList*>(data);
    if(list->count>=8)return FALSE;
    MONITORINFO info{sizeof(info)};if(!GetMonitorInfoW(monitor,&info))return FALSE;
    list->items[list->count++]={monitor,info.rcMonitor};return TRUE;
}
struct Renderer {
    struct Apartment {bool owned=false;~Apartment(){if(owned)RoUninitialize();}} apartment;
    std::mutex mutex,statsMutex;
    HWND owner;DWORD uiThread=GetCurrentThreadId();int width,height,capacityWidth,capacityHeight,padding=0;
    bool includeAdjacent=false,preferDxgi=true,historyValid=false,pointerReady=false;
    double lastLight=0,lastLightPass=0,lastProbe=0,lastPointer=0,pointerX=0,pointerY=0,pointerPresence=0;
    DG_Parameters lastParameters{};
    RECT lastViewport{},cachedMonitorBounds{};
    HMONITOR cachedMonitor=nullptr;
    uint64_t roiVersion=0,lastRoiVersion=0;
    double settledAfter=0;
    GraphicsCaptureItem selected{nullptr};HMONITOR selectedMonitor=nullptr;
    ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;ComPtr<IDXGIAdapter1> adapter;
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice bridge{nullptr};
    ComPtr<ID3D11VertexShader> vertex;ComPtr<ID3D11PixelShader> lens,lightDownsample,lightReduce,probe;
    ComPtr<ID3D11Buffer> constants,materials;ComPtr<ID3D11SamplerState> sampler;
    ComPtr<ID3D11Texture2D> atlas,lightDownTexture,lightTexture,lightHistory,probeTexture,probeReadback;
    ComPtr<ID3D11RenderTargetView> atlasTarget,lightDownTarget,lightTarget,probeTarget;
    ComPtr<ID3D11ShaderResourceView> atlasView,lightDownView,lightView,historyView;
    std::map<HMONITOR,std::unique_ptr<WgcTile>> wgc;
    std::map<HMONITOR,std::unique_ptr<DxgiTile>> dxgi;
    std::map<HMONITOR,double> retryAfter;
    std::shared_ptr<WakeBridge> wakeBridge=std::make_shared<WakeBridge>();
    Presenter presenter;Slot slots[3];int current=-1;DG_Stats stats{},publishedStats{};
    Renderer(HWND host,int w,int h):owner(host),width(w),height(h),capacityWidth(w),capacityHeight(h){}
    ~Renderer(){
        wgc.clear();dxgi.clear();if(context){context->ClearState();context->Flush();}
        selected=nullptr;bridge=nullptr;
    }
    void PublishStats(){std::lock_guard guard(statsMutex);publishedStats=stats;}
    void RequireUi(){if(GetCurrentThreadId()!=uiThread)winrt::throw_hresult(RPC_E_WRONG_THREAD);}
    void Texture(int w,int h,DXGI_FORMAT format,ComPtr<ID3D11Texture2D>& texture,
        ComPtr<ID3D11RenderTargetView>& target,ComPtr<ID3D11ShaderResourceView>* view=nullptr){
        D3D11_TEXTURE2D_DESC desc{};desc.Width=w;desc.Height=h;desc.MipLevels=desc.ArraySize=1;
        desc.Format=format;desc.SampleDesc.Count=1;desc.BindFlags=D3D11_BIND_RENDER_TARGET;
        if(view)desc.BindFlags|=D3D11_BIND_SHADER_RESOURCE;
        winrt::check_hresult(device->CreateTexture2D(&desc,nullptr,&texture));
        winrt::check_hresult(device->CreateRenderTargetView(texture.Get(),nullptr,&target));
        if(view)winrt::check_hresult(device->CreateShaderResourceView(texture.Get(),nullptr,view->ReleaseAndGetAddressOf()));
    }
    ComPtr<ID3DBlob> Compile(const char* entry,const char* profile){
        // Only CPU bytecode survives a reset, never a device/capture texture.
        static std::mutex compileMutex;static std::map<std::string,ComPtr<ID3DBlob>> bytecode;
        std::lock_guard guard(compileMutex);auto found=bytecode.find(entry);if(found!=bytecode.end())return found->second;
        ComPtr<ID3DBlob> code,error;HRESULT hr=D3DCompile(DG_Shader,std::strlen(DG_Shader),"desktop-glass",nullptr,nullptr,
            entry,profile,D3DCOMPILE_ENABLE_STRICTNESS|D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&code,&error);
        if(FAILED(hr)&&error)diagnostic.assign(static_cast<const char*>(error->GetBufferPointer()),error->GetBufferSize());
        winrt::check_hresult(hr);bytecode.emplace(entry,code);return code;
    }
    void Init(){
        HRESULT initialized=RoInitialize(RO_INIT_SINGLETHREADED);apartment.owned=SUCCEEDED(initialized);
        if(FAILED(initialized)&&initialized!=RPC_E_CHANGED_MODE)winrt::check_hresult(initialized);
        ComPtr<IDXGIFactory1> factory;winrt::check_hresult(CreateDXGIFactory1(IID_PPV_ARGS(&factory)));
        HMONITOR nearest=MonitorFromWindow(owner,MONITOR_DEFAULTTONEAREST);
        for(UINT i=0;;++i){
            ComPtr<IDXGIAdapter1> candidate;if(factory->EnumAdapters1(i,&candidate)==DXGI_ERROR_NOT_FOUND)break;
            for(UINT j=0;;++j){ComPtr<IDXGIOutput> output;if(candidate->EnumOutputs(j,&output)==DXGI_ERROR_NOT_FOUND)break;
                DXGI_OUTPUT_DESC desc{};if(SUCCEEDED(output->GetDesc(&desc))&&desc.Monitor==nearest){adapter=candidate;break;}}
            if(adapter)break;
        }
        winrt::check_hresult(D3D11CreateDevice(adapter.Get(),adapter?D3D_DRIVER_TYPE_UNKNOWN:D3D_DRIVER_TYPE_HARDWARE,nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context));
        ComPtr<IDXGIDevice1> gpu;winrt::check_hresult(device.As(&gpu));
        winrt::check_hresult(gpu->SetMaximumFrameLatency(2));
        if(!adapter){ComPtr<IDXGIAdapter> found;winrt::check_hresult(gpu->GetAdapter(&found));winrt::check_hresult(found.As(&adapter));}
        winrt::com_ptr<IInspectable> inspectable;winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(gpu.Get(),inspectable.put()));
        bridge=inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
        auto vs=Compile("VS","vs_4_0"),ps=Compile("LensPS","ps_4_0");
        auto ld=Compile("LightDownsamplePS","ps_4_0"),lr=Compile("LightReducePS","ps_4_0"),ts=Compile("ProbePS","ps_4_0");
        winrt::check_hresult(device->CreateVertexShader(vs->GetBufferPointer(),vs->GetBufferSize(),nullptr,&vertex));
        winrt::check_hresult(device->CreatePixelShader(ps->GetBufferPointer(),ps->GetBufferSize(),nullptr,&lens));
        winrt::check_hresult(device->CreatePixelShader(ld->GetBufferPointer(),ld->GetBufferSize(),nullptr,&lightDownsample));
        winrt::check_hresult(device->CreatePixelShader(lr->GetBufferPointer(),lr->GetBufferSize(),nullptr,&lightReduce));
        winrt::check_hresult(device->CreatePixelShader(ts->GetBufferPointer(),ts->GetBufferSize(),nullptr,&probe));
        D3D11_BUFFER_DESC buffer{};buffer.ByteWidth=sizeof(DG_ShaderConstants);buffer.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        winrt::check_hresult(device->CreateBuffer(&buffer,nullptr,&constants));
        buffer.ByteWidth=sizeof(DG_MaterialConstants);winrt::check_hresult(device->CreateBuffer(&buffer,nullptr,&materials));
        D3D11_SAMPLER_DESC sampling{};sampling.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sampling.AddressU=sampling.AddressV=sampling.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;sampling.MaxLOD=D3D11_FLOAT32_MAX;
        winrt::check_hresult(device->CreateSamplerState(&sampling,&sampler));
        Texture(24,12,DXGI_FORMAT_R16G16B16A16_FLOAT,lightDownTexture,lightDownTarget,&lightDownView);
        Texture(10,1,DXGI_FORMAT_R32G32B32A32_FLOAT,lightTexture,lightTarget,&lightView);
        ComPtr<ID3D11RenderTargetView> historyTarget;Texture(10,1,DXGI_FORMAT_R32G32B32A32_FLOAT,lightHistory,historyTarget,&historyView);
        const float zero[4]={};context->ClearRenderTargetView(historyTarget.Get(),zero);
        Texture(4,1,DXGI_FORMAT_R32G32B32A32_FLOAT,probeTexture,probeTarget);
        D3D11_TEXTURE2D_DESC staging{};staging.Width=4;staging.Height=staging.MipLevels=staging.ArraySize=1;
        staging.Format=DXGI_FORMAT_R32G32B32A32_FLOAT;staging.SampleDesc.Count=1;staging.Usage=D3D11_USAGE_STAGING;staging.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
        winrt::check_hresult(device->CreateTexture2D(&staging,nullptr,&probeReadback));
        for(auto& slot:slots){
            D3D11_QUERY_DESC q{D3D11_QUERY_EVENT,0};winrt::check_hresult(device->CreateQuery(&q,&slot.done));
            q.Query=D3D11_QUERY_TIMESTAMP;winrt::check_hresult(device->CreateQuery(&q,&slot.begin));winrt::check_hresult(device->CreateQuery(&q,&slot.end));
            q.Query=D3D11_QUERY_TIMESTAMP_DISJOINT;winrt::check_hresult(device->CreateQuery(&q,&slot.disjoint));
        }
        winrt::check_bool(SetWindowDisplayAffinity(owner,WDA_EXCLUDEFROMCAPTURE));presenter.Init(device.Get(),owner,width,height);
    }
    void EnsureSlotTexture(Slot& slot){
        if(!slot.texture)Texture(capacityWidth,capacityHeight,DXGI_FORMAT_B8G8R8A8_UNORM,slot.texture,slot.target);
    }
    void ResetFrames(){
        wgc.clear();dxgi.clear();retryAfter.clear();historyValid=false;current=-1;roiVersion=lastRoiVersion=0;
        lastLightPass=lastProbe=0;cachedMonitor=nullptr;
        for(auto& slot:slots){slot.state=0;slot.queryActive=false;}
        presenter.hasFrame.store(false,std::memory_order_release);
        presenter.shown.store(false,std::memory_order_release);
        ShowWindow(presenter.window,SW_HIDE);
        PublishStats();
    }
    void CompleteAll(){
        winrt::check_hresult(device->GetDeviceRemovedReason());
        bool updated=false;
        for(int i=0;i<3;++i){
            auto& slot=slots[i];
            if(!slot.queryActive)continue;
            HRESULT hr=context->GetData(slot.done.Get(),nullptr,0,D3D11_ASYNC_GETDATA_DONOTFLUSH);
            if(hr==S_FALSE)continue;
            winrt::check_hresult(hr);
            slot.queryActive=false;
            D3D11_QUERY_DATA_TIMESTAMP_DISJOINT duration{};UINT64 begin=0,end=0;
            if(context->GetData(slot.disjoint.Get(),&duration,sizeof(duration),0)==S_OK&&!duration.Disjoint&&duration.Frequency&&
               context->GetData(slot.begin.Get(),&begin,sizeof(begin),0)==S_OK&&context->GetData(slot.end.Get(),&end,sizeof(end),0)==S_OK&&end>=begin)
                slot.gpuMs=double(end-begin)*1000/double(duration.Frequency);
            if(slot.probeCount){
                D3D11_MAPPED_SUBRESOURCE mapped{};
                HRESULT probeResult=context->Map(probeReadback.Get(),0,D3D11_MAP_READ,D3D11_MAP_FLAG_DO_NOT_WAIT,&mapped);
                if(probeResult!=DXGI_ERROR_WAS_STILL_DRAWING){
                    winrt::check_hresult(probeResult);auto values=static_cast<const float*>(mapped.pData);
                    for(unsigned p=0;p<slot.probeCount;++p)stats.probe_luminance[p]=std::clamp(values[p*4],0.f,1.f);
                    context->Unmap(probeReadback.Get(),0);stats.probe_readback_bytes+=64;
                }
            }
            if(slot.state==1){
                for(auto& old:slots)if(old.state==2)old.state=0;
                slot.state=2;
            }
            stats.gpu_ms=slot.gpuMs;++stats.completed;updated=true;
        }
        if(updated)PublishStats();
    }
    std::unique_ptr<DxgiTile> CreateDxgi(HMONITOR monitor){
        for(UINT i=0;;++i){
            ComPtr<IDXGIOutput> output;if(adapter->EnumOutputs(i,&output)==DXGI_ERROR_NOT_FOUND)break;
            DXGI_OUTPUT_DESC desc{};if(FAILED(output->GetDesc(&desc))||desc.Monitor!=monitor)continue;
            // Duplication exposes unrotated pixels. Let WGC supply display-oriented pixels.
            if(desc.Rotation!=DXGI_MODE_ROTATION_IDENTITY){stats.last_capture_error=DXGI_ERROR_UNSUPPORTED;return nullptr;}
            auto tile=std::make_unique<DxgiTile>();
            HRESULT hr=E_NOINTERFACE;
            // Prefer DXGI 1.5 DuplicateOutput1 (supports HDR / 10-bit / ACM displays on Win11).
            ComPtr<IDXGIOutput5> output5;
            if(SUCCEEDED(output.As(&output5))){
                DXGI_FORMAT formats[]={DXGI_FORMAT_B8G8R8A8_UNORM};
                hr=output5->DuplicateOutput1(device.Get(),0,1,formats,&tile->duplication);
            }
            if(FAILED(hr)){
                ComPtr<IDXGIOutput1> output1;
                if(SUCCEEDED(output.As(&output1)))hr=output1->DuplicateOutput(device.Get(),&tile->duplication);
            }
            if(FAILED(hr)){stats.last_capture_error=hr;return nullptr;}
            tile->width=desc.DesktopCoordinates.right-desc.DesktopCoordinates.left;tile->height=desc.DesktopCoordinates.bottom-desc.DesktopCoordinates.top;
            D3D11_TEXTURE2D_DESC image{};image.Width=tile->width;image.Height=tile->height;image.MipLevels=image.ArraySize=1;
            image.Format=DXGI_FORMAT_B8G8R8A8_UNORM;image.SampleDesc.Count=1;
            winrt::check_hresult(device->CreateTexture2D(&image,nullptr,&tile->texture));return tile;
        }
        stats.last_capture_error=DXGI_ERROR_NOT_FOUND;return nullptr;
    }
    bool Capture(Piece& piece,RECT region,double& oldest,bool& roiDirty){
        RECT& intersection=piece.intersection;if(!IntersectRect(&intersection,&region,&piece.bounds))return true;
        int sx=intersection.left-piece.bounds.left,sy=intersection.top-piece.bounds.top;
        int w=intersection.right-intersection.left,h=intersection.bottom-intersection.top;
        RECT localRegion{sx,sy,sx+w,sy+h};
        ID3D11Texture2D* source=nullptr;double sourceTime=0;
        if(preferDxgi&&retryAfter[piece.monitor]<=Now()){
            auto& tile=dxgi[piece.monitor];if(!tile)tile=CreateDxgi(piece.monitor);
            if(tile){
                ComPtr<IDXGIResource> resource;DXGI_OUTDUPL_FRAME_INFO info{};
                HRESULT hr=tile->duplication->AcquireNextFrame(0,&info,&resource);
                if(SUCCEEDED(hr)){
                    if(info.LastPresentTime.QuadPart>0){
                        ComPtr<ID3D11Texture2D> texture;
                        HRESULT cast=resource.As(&texture);
                        if(FAILED(cast)){tile->duplication->ReleaseFrame();winrt::check_hresult(cast);}
                        bool copiedIncremental=false;
                        bool pieceRoiHit=false;
                        if(tile->valid&&info.TotalMetadataBufferSize>0){
                            if(tile->metadata.size()<info.TotalMetadataBufferSize)tile->metadata.resize(info.TotalMetadataBufferSize);
                            UINT moveBytes=0,dirtyBytes=0;
                            auto* movePtr=reinterpret_cast<DXGI_OUTDUPL_MOVE_RECT*>(tile->metadata.data());
                            HRESULT hrMove=tile->duplication->GetFrameMoveRects(UINT(tile->metadata.size()),movePtr,&moveBytes);
                            UINT moveCount=SUCCEEDED(hrMove)?moveBytes/sizeof(DXGI_OUTDUPL_MOVE_RECT):0;
                            UINT dirtyCap=moveBytes<tile->metadata.size()?UINT(tile->metadata.size()-moveBytes):0;
                            auto* dirtyPtr=reinterpret_cast<RECT*>(tile->metadata.data()+moveBytes);
                            HRESULT hrDirty=SUCCEEDED(hrMove)&&dirtyCap?tile->duplication->GetFrameDirtyRects(dirtyCap,dirtyPtr,&dirtyBytes):E_FAIL;
                            UINT dirtyCount=SUCCEEDED(hrDirty)?dirtyBytes/sizeof(RECT):0;
                            if(SUCCEEDED(hrMove)&&SUCCEEDED(hrDirty)&&(moveCount>0||dirtyCount>0)){
                                uint64_t dirtyArea=0;
                                for(UINT d=0;d<dirtyCount;++d){
                                    RECT clamped{std::clamp<LONG>(dirtyPtr[d].left,0,tile->width),std::clamp<LONG>(dirtyPtr[d].top,0,tile->height),
                                        std::clamp<LONG>(dirtyPtr[d].right,0,tile->width),std::clamp<LONG>(dirtyPtr[d].bottom,0,tile->height)};
                                    if(clamped.right>clamped.left&&clamped.bottom>clamped.top){
                                        dirtyArea+=uint64_t(clamped.right-clamped.left)*uint64_t(clamped.bottom-clamped.top);
                                        RECT hit{};if(IntersectRect(&hit,&clamped,&localRegion))pieceRoiHit=true;
                                    }
                                }
                                for(UINT m=0;m<moveCount;++m){
                                    RECT dst=movePtr[m].DestinationRect,hit{};
                                    if(IntersectRect(&hit,&dst,&localRegion))pieceRoiHit=true;
                                    RECT src{movePtr[m].SourcePoint.x,movePtr[m].SourcePoint.y,
                                        movePtr[m].SourcePoint.x+(dst.right-dst.left),movePtr[m].SourcePoint.y+(dst.bottom-dst.top)};
                                    if(IntersectRect(&hit,&src,&localRegion))pieceRoiHit=true;
                                }
                                uint64_t totalArea=uint64_t(tile->width)*uint64_t(tile->height);
                                if(moveCount==0&&dirtyCount>0&&dirtyArea*100<=totalArea*45){
                                    for(UINT d=0;d<dirtyCount;++d){
                                        LONG l=std::clamp<LONG>(dirtyPtr[d].left,0,tile->width);
                                        LONG t=std::clamp<LONG>(dirtyPtr[d].top,0,tile->height);
                                        LONG r=std::clamp<LONG>(dirtyPtr[d].right,0,tile->width);
                                        LONG b=std::clamp<LONG>(dirtyPtr[d].bottom,0,tile->height);
                                        if(r>l&&b>t){
                                            D3D11_BOX box{UINT(l),UINT(t),0,UINT(r),UINT(b),1};
                                            context->CopySubresourceRegion(tile->texture.Get(),0,UINT(l),UINT(t),0,texture.Get(),0,&box);
                                        }
                                    }
                                    copiedIncremental=true;
                                }else{
                                    context->CopyResource(tile->texture.Get(),texture.Get());
                                    copiedIncremental=true;
                                }
                                if(pieceRoiHit)roiDirty=true;
                            }
                        }
                        if(!copiedIncremental){
                            context->CopyResource(tile->texture.Get(),texture.Get());
                            roiDirty=true;
                        }
                        tile->timestamp=QpcTime(info.LastPresentTime.QuadPart);tile->valid=true;++stats.captured;
                    }
                    tile->duplication->ReleaseFrame();
                }else if(hr!=DXGI_ERROR_WAIT_TIMEOUT){stats.last_capture_error=hr;tile.reset();}
                if(tile){
                    if(!tile->valid)return false;
                    if(sx+w>tile->width||sy+h>tile->height)winrt::throw_hresult(E_BOUNDS);
                    source=tile->texture.Get();sourceTime=tile->timestamp;stats.backend=1;
                }
            }
            if(!tile){
                // Avoid hammering DXGI every 5s when blocked by E_ACCESSDENIED or unsupported output.
                double backoff=(stats.last_capture_error==E_ACCESSDENIED||stats.last_capture_error==DXGI_ERROR_UNSUPPORTED)?60.0:5.0;
                retryAfter[piece.monitor]=Now()+backoff;
            }
        }
        if(!source){
            auto& tile=wgc[piece.monitor];
            if(!tile){
                GraphicsCaptureItem item=selected;
                if(piece.monitor!=selectedMonitor){auto factory=winrt::get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
                    winrt::check_hresult(factory->CreateForMonitor(piece.monitor,winrt::guid_of<GraphicsCaptureItem>(),winrt::put_abi(item)));}
                tile=std::make_unique<WgcTile>();tile->Init(item,bridge,wakeBridge);
            }
            bool wgcRoiHit=false;
            try{if(!tile->Update(stats.captured,localRegion,wgcRoiHit))return false;}
            catch(winrt::hresult_error const& error){if(error.code()==DXGI_ERROR_MODE_CHANGE_IN_PROGRESS){tile.reset();return false;}throw;}
            if(wgcRoiHit)roiDirty=true;
            if(sx+w>tile->width||sy+h>tile->height)winrt::throw_hresult(E_BOUNDS);
            source=tile->texture.Get();sourceTime=tile->timestamp;stats.backend=2;
        }
        piece.source=source;
        oldest=std::min(oldest,sourceTime);return true;
    }
    HRESULT Render(int x,int y,DG_Parameters const& p,bool presentDirectly=false){
        const double renderStart=Now();
        DpiScope dpi;if(!selected||!presenter.visible.load(std::memory_order_acquire))return S_FALSE;
        CompleteAll();
        int free=-1;
        for(int i=0;i<3;++i)if(slots[i].state==0&&!slots[i].queryActive){free=i;break;}
        if(free<0){
            for(int i=0;i<3;++i)if((slots[i].state==2||slots[i].state==4)&&!slots[i].queryActive){free=i;break;}
        }
        if(free<0)return S_FALSE;
        const float numbers[]={p.dpi_scale,p.corner_radius_dip,p.bezel_dip,p.thickness_dip,p.refraction_index,p.refraction_strength,p.tint,
            p.highlight_strength,p.capture_padding_dip,p.sensing_radius_dip,p.shape_x_px,p.shape_y_px,p.pressure,p.pointer_screen_x_px,p.pointer_screen_y_px,p.pointer_presence};
        for(float value:numbers)if(!std::isfinite(value))return E_INVALIDARG;
        if(p.dpi_scale<=0||p.bezel_dip<=0||p.thickness_dip<0||p.refraction_index<1||p.capture_padding_dip<2||
            p.sensing_radius_dip<0||p.probe_count>4||p.material_count>2||(p.probe_count&&p.probe_interval==0))return E_INVALIDARG;
        DG_MaterialConstants materialData{};
        for(unsigned i=0;i<p.material_count;++i){
            auto const& m=p.materials[i];const float values[]={m.x,m.y,m.width,m.height,m.columns,m.rows,m.gap_x,m.gap_y,m.radius,m.blur};
            for(float value:values)if(!std::isfinite(value))return E_INVALIDARG;
            if(m.columns<1||m.rows<1||m.width<=0||m.height<=0||m.blur<0)return E_INVALIDARG;
            float* r=materialData.rect[i];r[0]=m.x;r[1]=m.y;r[2]=m.width;r[3]=m.height;
            float* g=materialData.grid[i];g[0]=m.columns;g[1]=m.rows;g[2]=m.gap_x;g[3]=m.gap_y;
            materialData.surface[i][0]=m.radius;materialData.surface[i][1]=m.blur;
        }
        int halo=int(std::ceil(p.capture_padding_dip*p.dpi_scale));
        RECT region{x-halo,y-halo,x+width+halo,y+height+halo};
        PieceList pieces{};
        if(includeAdjacent){winrt::check_bool(EnumDisplayMonitors(nullptr,&region,Enumerate,reinterpret_cast<LPARAM>(&pieces)));}
        else{
            if(cachedMonitor!=selectedMonitor){
                MONITORINFO info{sizeof(info)};winrt::check_bool(GetMonitorInfoW(selectedMonitor,&info));
                cachedMonitor=selectedMonitor;cachedMonitorBounds=info.rcMonitor;
            }
            pieces.items[pieces.count++]={selectedMonitor,cachedMonitorBounds};
        }
        if(pieces.count==0)return S_FALSE;
        auto active=[&](HMONITOR m){
            for(int i=0;i<pieces.count;++i)if(pieces.items[i].monitor==m)return true;
            return false;
        };
        for(auto it=wgc.begin();it!=wgc.end();)if(!active(it->first))it=wgc.erase(it);else++it;
        for(auto it=dxgi.begin();it!=dxgi.end();)if(!active(it->first))it=dxgi.erase(it);else++it;
        double start=Now(),oldest=1e30;bool roiDirty=false;
        for(int i=0;i<pieces.count;++i)if(!Capture(pieces.items[i],region,oldest,roiDirty))return S_FALSE;
        if(oldest==1e30)return S_FALSE;
        if(roiDirty)++roiVersion;
        double now=Now();
        RECT viewportRect{x,y,x+width,y+height};
        bool sameInputs=historyValid&&EqualRect(&viewportRect,&lastViewport)&&lastRoiVersion==roiVersion&&
            std::memcmp(&lastParameters,&p,sizeof(p))==0;
        if(sameInputs&&current>=0&&slots[current].serial==stats.submitted){
            if(now>=settledAfter||(now-lastLightPass<.030))return S_FALSE;
        }
        if(!sameInputs)settledAfter=now+.22;
        if(!presentDirectly){lastRoiVersion=roiVersion;lastParameters=p;lastViewport=viewportRect;}
        ID3D11ShaderResourceView* empty[3]={};context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
        if(!atlas||padding!=halo){atlas.Reset();atlasTarget.Reset();atlasView.Reset();padding=halo;
            Texture(capacityWidth+2*halo,capacityHeight+2*halo,DXGI_FORMAT_B8G8R8A8_UNORM,atlas,atlasTarget,&atlasView);historyValid=false;}
        bool fullRegionCovered=pieces.count==1&&pieces.items[0].source&&EqualRect(&pieces.items[0].intersection,&region);
        const float zero[4]={};
        if(!fullRegionCovered)context->ClearRenderTargetView(atlasTarget.Get(),zero);
        for(int pi=0;pi<pieces.count;++pi)if(pieces.items[pi].source){
            auto const& piece=pieces.items[pi];auto const& i=piece.intersection;
            D3D11_BOX box{};box.left=i.left-piece.bounds.left;box.top=i.top-piece.bounds.top;
            box.right=i.right-piece.bounds.left;box.bottom=i.bottom-piece.bounds.top;box.back=1;
            context->CopySubresourceRegion(atlas.Get(),0,i.left-region.left,i.top-region.top,0,piece.source,0,&box);
        }
        stats.capture_ms=(Now()-start)*1000;
        DG_ShaderConstants data{};
        data.viewport[0]=float(width);data.viewport[1]=float(height);data.viewport[2]=p.dpi_scale;data.viewport[3]=float(halo);
        data.optics[0]=p.corner_radius_dip<0?std::min(width,height)*.5f:std::clamp(p.corner_radius_dip*p.dpi_scale,0.f,std::min(width,height)*.5f);
        data.optics[1]=p.bezel_dip*p.dpi_scale;data.optics[2]=p.thickness_dip*p.dpi_scale;data.optics[3]=p.refraction_index;
        data.appearance[0]=p.refraction_strength;data.appearance[1]=p.tint;data.appearance[2]=p.highlight_strength;data.appearance[3]=p.sensing_radius_dip;
        data.shape[0]=p.shape_x_px;data.shape[1]=p.shape_y_px;data.shape[2]=p.pressure;
        data.shape[3]=float(p.material_count);data.history[2]=float(capacityWidth+2*halo);data.history[3]=float(capacityHeight+2*halo);
        double dt=std::clamp(now-lastLight,0.,.1);data.history[0]=float(1-std::exp(-dt/.020));data.history[1]=historyValid?1.f:0.f;
        bool jumpReset=false;
        if(current>=0){auto const& prior=slots[current];
            float jump=std::max(32.f,p.sensing_radius_dip*.5f)*p.dpi_scale;
            if(std::abs(prior.x-x)>jump||std::abs(prior.y-y)>jump||
               std::abs(prior.width-width)>jump||std::abs(prior.height-height)>jump){data.history[1]=0;jumpReset=true;}}
        if(data.history[1]<.5f)++stats.light_history_resets;
        // Rate-cap the 2-pass light field to ~60Hz (16ms) during 75-240Hz motion while reacting
        // on every frame at 60Hz for crisp stationary scene transitions.
        bool runLight=!historyValid||jumpReset||(now-lastLightPass>=.016);
        if(runLight){lastLight=now;lastLightPass=now;historyValid=true;}
        double pointerBlend=1-std::exp(-std::clamp(now-lastPointer,0.,.1)/.025);lastPointer=now;
        if(!pointerReady){pointerX=p.pointer_screen_x_px;pointerY=p.pointer_screen_y_px;pointerReady=true;}
        pointerX+=(p.pointer_screen_x_px-pointerX)*pointerBlend;pointerY+=(p.pointer_screen_y_px-pointerY)*pointerBlend;
        pointerPresence+=(std::clamp(p.pointer_presence,0.f,1.f)-pointerPresence)*pointerBlend;
        data.pointer[0]=float(pointerX-x);data.pointer[1]=float(pointerY-y);data.pointer[2]=float(pointerPresence);
        for(unsigned i=0;i<4;++i){float* probes=i<2?data.probes01:data.probes23;unsigned offset=(i%2)*2;
            if(!std::isfinite(p.probes[i].x)||!std::isfinite(p.probes[i].y))return E_INVALIDARG;
            probes[offset]=p.probes[i].x;probes[offset+1]=p.probes[i].y;}

        // Acquire direct swapchain backbuffer RTV when presenting inline (zero intermediate CopyResource).
        ComPtr<ID3D11Texture2D> backBuffer;
        ComPtr<ID3D11RenderTargetView> backTarget;
        ID3D11RenderTargetView* lensOut=nullptr;
        auto& slot=slots[free];
        if(presentDirectly){
            winrt::check_hresult(presenter.swap->GetBuffer(0,IID_PPV_ARGS(&backBuffer)));
            winrt::check_hresult(device->CreateRenderTargetView(backBuffer.Get(),nullptr,&backTarget));
            lensOut=backTarget.Get();
        }else{
            EnsureSlotTexture(slot);
            lensOut=slot.target.Get();
        }

        slot.x=x;slot.y=y;slot.width=width;slot.height=height;slot.serial=++stats.submitted;
        slot.sourceTime=oldest;slot.submittedAt=renderStart;slot.state=1;slot.gpuMs=0;slot.queryActive=true;
        context->Begin(slot.disjoint.Get());context->End(slot.begin.Get());
        context->UpdateSubresource(constants.Get(),0,nullptr,&data,0,0);
        context->UpdateSubresource(materials.Get(),0,nullptr,&materialData,0,0);
        ID3D11Buffer* buffers[2]={constants.Get(),materials.Get()};ID3D11SamplerState* sample=sampler.Get();
        context->VSSetShader(vertex.Get(),nullptr,0);context->PSSetConstantBuffers(0,2,buffers);context->PSSetSamplers(0,1,&sample);
        context->IASetInputLayout(nullptr);context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);

        ID3D11ShaderResourceView* source=atlasView.Get();
        if(runLight){
            // Pass 1a: 24x12 parallel light downsample (1,152 taps across 288 threads)
            D3D11_VIEWPORT downViewport{0,0,24,12,0,1};context->RSSetViewports(1,&downViewport);
            ID3D11RenderTargetView* downOut=lightDownTarget.Get();context->OMSetRenderTargets(1,&downOut,nullptr);
            context->PSSetShaderResources(0,1,&source);
            context->PSSetShader(lightDownsample.Get(),nullptr,0);context->Draw(3,0);
            context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);

            // Pass 1b: 10x1 light reduction reading 24x12 L1-cached downsample + history
            D3D11_VIEWPORT lightViewport{0,0,10,1,0,1};context->RSSetViewports(1,&lightViewport);
            ID3D11RenderTargetView* lightOut=lightTarget.Get();context->OMSetRenderTargets(1,&lightOut,nullptr);
            ID3D11ShaderResourceView* lightInputs[3]={lightDownView.Get(),nullptr,historyView.Get()};
            context->PSSetShaderResources(0,3,lightInputs);
            context->PSSetShader(lightReduce.Get(),nullptr,0);context->Draw(3,0);
            context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
            context->CopyResource(lightHistory.Get(),lightTexture.Get());
        }

        // Pass 2: Full-resolution refraction, independent local frost, and pure-color Fresnel edge
        context->ClearRenderTargetView(lensOut,zero);
        D3D11_VIEWPORT viewport{0,0,float(width),float(height),0,1};context->RSSetViewports(1,&viewport);
        context->OMSetRenderTargets(1,&lensOut,nullptr);
        ID3D11ShaderResourceView* views[2]={atlasView.Get(),lightView.Get()};context->PSSetShaderResources(0,2,views);
        context->PSSetShader(lens.Get(),nullptr,0);context->Draw(3,0);
        context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
        backTarget.Reset();backBuffer.Reset();

        // Time-based luminance probe (max 4Hz during motion instead of every 10 frames).
        bool readProbe=p.probe_count&&(stats.submitted==1||(now-lastProbe>=.25));
        slot.probeCount=readProbe?p.probe_count:0;
        if(readProbe){
            lastProbe=now;
            D3D11_VIEWPORT probeViewport{0,0,4,1,0,1};context->RSSetViewports(1,&probeViewport);ID3D11RenderTargetView* out=probeTarget.Get();
            context->OMSetRenderTargets(1,&out,nullptr);context->PSSetShaderResources(0,1,&source);
            context->PSSetShader(probe.Get(),nullptr,0);context->Draw(3,0);context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
            context->CopyResource(probeReadback.Get(),probeTexture.Get());
        }
        context->End(slot.end.Get());context->End(slot.disjoint.Get());context->End(slot.done.Get());

        if(presentDirectly){
            HRESULT phr=presenter.PresentBackBuffer();
            if(phr==S_OK){
                if(current>=0)slots[current].state=0;
                current=free;slot.state=4;
                lastRoiVersion=roiVersion;lastParameters=p;lastViewport=viewportRect;
                double presentedAt=Now();
                ++stats.presented;
                stats.source_age_ms=std::max(0.,(presentedAt-slot.sourceTime)*1000);
                stats.render_to_present_ms=(presentedAt-slot.submittedAt)*1000;
                stats.presented_x_px=slot.x;stats.presented_y_px=slot.y;
                stats.presented_width_px=slot.width;stats.presented_height_px=slot.height;
                PublishStats();
                return S_OK;
            }
            // Keep lastRoiVersion uncommitted on WAS_STILL_DRAWING so the next VBlank
            // automatically retries and never leaves a stale final frame behind.
            PublishStats();
            return phr;
        }
        context->Flush();
        PublishStats();
        return S_OK;
    }
};
Renderer& Object(DG_Handle handle){if(!handle)winrt::throw_hresult(E_POINTER);return *static_cast<Renderer*>(handle);}
}

void __cdecl DG_DefaultParameters(DG_Parameters* p){
    if(!p)return;*p={};p->dpi_scale=1;p->corner_radius_dip=-1;p->bezel_dip=16;p->thickness_dip=120;
    p->refraction_index=1.5f;p->refraction_strength=.72f;p->tint=.12f;p->highlight_strength=1;
    p->capture_padding_dip=112;p->sensing_radius_dip=96;p->probe_interval=120;
}
HRESULT __cdecl DG_Create(HWND owner,int width,int height,DG_Handle* result){
    if(!result)return E_POINTER;*result=nullptr;if(!IsWindow(owner)||width<1||height<1)return E_INVALIDARG;
    if(GetWindowThreadProcessId(owner,nullptr)!=GetCurrentThreadId())return RPC_E_WRONG_THREAD;
    return Boundary([&]{auto renderer=std::make_unique<Renderer>(owner,width,height);renderer->Init();*result=renderer.release();return S_OK;});
}
HRESULT __cdecl DG_Destroy(DG_Handle handle){return Boundary([&]{auto& r=Object(handle);r.RequireUi();delete &r;return S_OK;});}
HRESULT __cdecl DG_SetViewport(DG_Handle handle,int width,int height){return Boundary([&]{auto& r=Object(handle);r.RequireUi();std::lock_guard guard(r.mutex);
    if(width<1||height<1||width>r.capacityWidth||height>r.capacityHeight)return E_INVALIDARG;
    r.width=width;r.height=height;return S_OK;});}
HRESULT __cdecl DG_PositionWithOwner(DG_Handle handle,int x,int y,int width,int height,int inset){return Boundary([&]{auto& r=Object(handle);r.RequireUi();
    if(width<1||height<1||width>r.capacityWidth||height>r.capacityHeight||inset<0)return E_INVALIDARG;
    r.presenter.hostGeometry=true;r.presenter.Position(x,y,width,height,inset);return S_OK;});}
HRESULT __cdecl DG_SelectMonitor(DG_Handle handle,HMONITOR monitor,BOOL adjacent,BOOL preferDxgi){
    return Boundary([&]{auto& r=Object(handle);r.RequireUi();std::lock_guard guard(r.mutex);
        GraphicsCaptureItem item{nullptr};auto factory=winrt::get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
        winrt::check_hresult(factory->CreateForMonitor(monitor,winrt::guid_of<GraphicsCaptureItem>(),winrt::put_abi(item)));
        r.ResetFrames();r.selected=item;r.selectedMonitor=monitor;r.includeAdjacent=adjacent!=FALSE;r.preferDxgi=preferDxgi!=FALSE;return S_OK;});
}
HRESULT __cdecl DG_SetCaptureItem(DG_Handle handle,IUnknown* item,HMONITOR monitor){
    if(!item||!monitor)return E_INVALIDARG;
    return Boundary([&]{auto& r=Object(handle);r.RequireUi();std::lock_guard guard(r.mutex);
        winrt::com_ptr<IInspectable> inspectable;winrt::check_hresult(item->QueryInterface(__uuidof(IInspectable),inspectable.put_void()));
        auto selected=inspectable.as<GraphicsCaptureItem>();MONITORINFO info{sizeof(info)};winrt::check_bool(GetMonitorInfoW(monitor,&info));
        if(selected.Size().Width!=info.rcMonitor.right-info.rcMonitor.left||selected.Size().Height!=info.rcMonitor.bottom-info.rcMonitor.top)return E_INVALIDARG;
        r.ResetFrames();r.selected=selected;r.selectedMonitor=monitor;r.includeAdjacent=false;r.preferDxgi=false;return S_OK;});
}
HRESULT __cdecl DG_ClearSource(DG_Handle handle){return Boundary([&]{auto& r=Object(handle);r.RequireUi();std::lock_guard guard(r.mutex);r.ResetFrames();r.selected=nullptr;r.selectedMonitor=nullptr;return S_OK;});}
HRESULT __cdecl DG_Render(DG_Handle handle,int x,int y,const DG_Parameters* p){
    if(!p)return E_POINTER;return Boundary([&]{auto& r=Object(handle);std::lock_guard guard(r.mutex);return r.Render(x,y,*p,false);});
}
HRESULT __cdecl DG_RenderViewport(DG_Handle handle,int x,int y,int width,int height,const DG_Parameters* p){
    if(!p)return E_POINTER;return Boundary([&]{auto& r=Object(handle);std::lock_guard guard(r.mutex);
        if(width<1||height<1||width>r.capacityWidth||height>r.capacityHeight)return E_INVALIDARG;
        r.width=width;r.height=height;return r.Render(x,y,*p,false);});
}
HRESULT __cdecl DG_RenderPresentViewport(DG_Handle handle,int x,int y,int width,int height,const DG_Parameters* p){
    if(!p)return E_POINTER;return Boundary([&]{auto& r=Object(handle);std::lock_guard guard(r.mutex);
        if(width<1||height<1||width>r.capacityWidth||height>r.capacityHeight)return E_INVALIDARG;
        r.width=width;r.height=height;return r.Render(x,y,*p,true);});
}
HRESULT __cdecl DG_EnsurePresentedVisible(DG_Handle handle){return Boundary([&]{auto& r=Object(handle);r.RequireUi();
    r.presenter.ShowIfNeeded();return S_OK;});}
HRESULT __cdecl DG_SetFrameWakeEvent(DG_Handle handle,HANDLE wake_event){return Boundary([&]{auto& r=Object(handle);
    r.wakeBridge->Set(wake_event);return S_OK;});}
HRESULT __cdecl DG_Present(DG_Handle handle){return Boundary([&]{auto& r=Object(handle);r.RequireUi();
    std::unique_lock guard(r.mutex,std::try_to_lock);if(!guard.owns_lock())return S_FALSE;
    r.CompleteAll();int ready=-1;for(int i=0;i<3;++i)if((r.slots[i].state==1||r.slots[i].state==2)&&(ready<0||r.slots[i].serial>r.slots[ready].serial))ready=i;
    if(ready<0)return S_FALSE;auto& slot=r.slots[ready];
    if(!slot.texture)return S_FALSE;
    HRESULT hr=r.presenter.Present(r.context.Get(),slot.texture.Get(),slot.x,slot.y,slot.width,slot.height);
    if(hr!=S_OK)return hr;if(r.current>=0)r.slots[r.current].state=0;r.current=ready;slot.state=4;
    ++r.stats.presented;r.stats.source_age_ms=std::max(0.,(Now()-slot.sourceTime)*1000);
    r.stats.render_to_present_ms=(Now()-slot.submittedAt)*1000;
    r.stats.presented_x_px=slot.x;r.stats.presented_y_px=slot.y;r.stats.presented_width_px=slot.width;r.stats.presented_height_px=slot.height;
    r.PublishStats();return S_OK;});}
HRESULT __cdecl DG_SetVisible(DG_Handle handle,BOOL visible){return Boundary([&]{auto& r=Object(handle);r.RequireUi();std::lock_guard guard(r.mutex);
    r.presenter.visible.store(visible!=FALSE,std::memory_order_release);if(!visible)r.ResetFrames();return S_OK;});}
HRESULT __cdecl DG_GetStats(DG_Handle handle,DG_Stats* stats){if(!stats)return E_POINTER;return Boundary([&]{auto& r=Object(handle);
    std::lock_guard guard(r.statsMutex);*stats=r.publishedStats;return S_OK;});}
HRESULT __cdecl DG_TryGetStats(DG_Handle handle,DG_Stats* stats){if(!stats)return E_POINTER;return Boundary([&]{auto& r=Object(handle);
    std::unique_lock guard(r.statsMutex,std::try_to_lock);if(!guard.owns_lock())return S_FALSE;*stats=r.publishedStats;return S_OK;});}
HWND __cdecl DG_GetCompositionWindow(DG_Handle handle){if(!handle)return nullptr;auto& r=Object(handle);std::lock_guard guard(r.mutex);return r.presenter.window;}
HRESULT __cdecl DG_ExcludeWindowFromCapture(HWND window){return SetWindowDisplayAffinity(window,WDA_EXCLUDEFROMCAPTURE)?S_OK:HRESULT_FROM_WIN32(GetLastError());}
void __cdecl DG_LastError(char* destination,int capacity){if(!destination||capacity<1)return;size_t n=std::min(diagnostic.size(),size_t(capacity-1));std::memcpy(destination,diagnostic.data(),n);destination[n]=0;}
