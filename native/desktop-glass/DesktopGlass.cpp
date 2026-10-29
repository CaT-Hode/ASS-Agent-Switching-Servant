#include "DesktopGlass.h"
#include "GlassShader.h"
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dcomp.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using namespace winrt::Windows::Graphics::Capture;
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
struct WgcTile {
    GraphicsCaptureItem item{nullptr};Direct3D11CaptureFramePool pool{nullptr};
    GraphicsCaptureSession capture{nullptr};Direct3D11CaptureFrame held{nullptr};
    ComPtr<ID3D11Texture2D> texture;int width=0,height=0;double timestamp=0;
    std::shared_ptr<std::atomic_bool> closed=std::make_shared<std::atomic_bool>(false);
    winrt::event_token closedToken{};bool subscribed=false;
    ~WgcTile(){
        try{if(subscribed)item.Closed(closedToken);}catch(...){}
        texture.Reset();try{if(held)held.Close();if(capture)capture.Close();if(pool)pool.Close();}catch(...){}
    }
    void Init(GraphicsCaptureItem source,winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice bridge){
        item=source;auto size=item.Size();width=size.Width;height=size.Height;
        if(width<1||height<1)winrt::throw_hresult(E_BOUNDS);
        closedToken=item.Closed([flag=closed](auto const&,auto const&)noexcept{flag->store(true);});subscribed=true;
        pool=Direct3D11CaptureFramePool::CreateFreeThreaded(bridge,DirectXPixelFormat::B8G8R8A8UIntNormalized,2,size);
        capture=pool.CreateCaptureSession(item);capture.IsCursorCaptureEnabled(false);
        // Leave the system capture indicator and access policy to Windows.
        capture.StartCapture();
    }
    bool Update(uint64_t& count){
        if(closed->load())winrt::throw_hresult(RO_E_CLOSED);
        auto frame=pool.TryGetNextFrame();if(!frame)return texture!=nullptr;
        while(auto newer=pool.TryGetNextFrame()){frame.Close();frame=newer;}
        auto size=frame.ContentSize();
        if(size.Width<1||size.Height<1){frame.Close();return false;}
        if(size.Width!=width||size.Height!=height){frame.Close();winrt::throw_hresult(DXGI_ERROR_MODE_CHANGE_IN_PROGRESS);}
        texture.Reset();if(held)held.Close();held=frame;
        auto access=held.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(&texture)));
        timestamp=double(held.SystemRelativeTime().count())/1e7;++count;return true;
    }
};
struct DxgiTile {
    ComPtr<IDXGIOutputDuplication> duplication;ComPtr<ID3D11Texture2D> texture;
    int width=0,height=0;double timestamp=0;bool valid=false;
};
LRESULT CALLBACK GlassWndProc(HWND window,UINT message,WPARAM wParam,LPARAM lParam){
    if(message==WM_NCHITTEST)return HTTRANSPARENT;
    if(message==WM_MOUSEACTIVATE)return MA_NOACTIVATE;
    return DefWindowProcW(window,message,wParam,lParam);
}
struct Presenter {
    HWND window=nullptr,owner=nullptr;int width=0,height=0,x=0,y=0;
    bool visible=true,hasFrame=false,hostGeometry=false;
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
        desc.SampleDesc.Count=1;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.BufferCount=2;
        desc.Scaling=DXGI_SCALING_STRETCH;desc.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;desc.AlphaMode=DXGI_ALPHA_MODE_PREMULTIPLIED;
        winrt::check_hresult(factory->CreateSwapChainForComposition(device,&desc,nullptr,&swap));
        winrt::check_hresult(composition->CreateTargetForHwnd(window,TRUE,&target));
        winrt::check_hresult(composition->CreateVisual(&visual));winrt::check_hresult(visual->SetContent(swap.Get()));
        winrt::check_hresult(target->SetRoot(visual.Get()));winrt::check_hresult(composition->Commit());
    }
    void Position(int sampleX,int sampleY,int w,int h,int ownerInset=-1){
        DpiScope dpi;
        bool stackChanged=((GetWindowLongPtrW(window,GWL_EXSTYLE)^GetWindowLongPtrW(owner,GWL_EXSTYLE))&WS_EX_TOPMOST)!=0;
        bool moveSurface=x!=sampleX||y!=sampleY,resizeSurface=width!=w||height!=h;
        bool updateSurface=moveSurface||resizeSurface||stackChanged||(hasFrame&&visible&&!IsWindowVisible(window));
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
                    (hasFrame&&visible?SWP_SHOWWINDOW:0);
                batch=DeferWindowPos(batch,window,owner,sampleX,sampleY,w,h,flags);winrt::check_bool(batch!=nullptr);
            }
            winrt::check_bool(EndDeferWindowPos(batch));
        }
        x=sampleX;y=sampleY;width=w;height=h;
    }
    HRESULT Present(ID3D11DeviceContext* context,ID3D11Texture2D* source,int sampleX,int sampleY,int w,int h){
        if(!visible)return S_FALSE;
        if(hostGeometry&&(sampleX!=x||sampleY!=y||w!=width||h!=height))return S_FALSE;
        ComPtr<ID3D11Texture2D> back;winrt::check_hresult(swap->GetBuffer(0,IID_PPV_ARGS(&back)));
        context->CopyResource(back.Get(),source);HRESULT hr=swap->Present(0,DXGI_PRESENT_DO_NOT_WAIT);
        if(hr==DXGI_ERROR_WAS_STILL_DRAWING)return S_FALSE;winrt::check_hresult(hr);
        hasFrame=true;Position(sampleX,sampleY,w,h);return S_OK;
    }
};
struct Slot {
    ComPtr<ID3D11Texture2D> texture;ComPtr<ID3D11RenderTargetView> target;
    ComPtr<ID3D11Query> done,begin,end,disjoint;
    int state=0,x=0,y=0,width=0,height=0;uint64_t serial=0;double sourceTime=0,gpuMs=0,submittedAt=0;uint32_t probeCount=0;
};
struct Piece {HMONITOR monitor;RECT bounds;};
BOOL CALLBACK Enumerate(HMONITOR monitor,HDC,LPRECT,LPARAM data){
    MONITORINFO info{sizeof(info)};if(!GetMonitorInfoW(monitor,&info))return FALSE;
    reinterpret_cast<std::vector<Piece>*>(data)->push_back({monitor,info.rcMonitor});return TRUE;
}
struct Renderer {
    struct Apartment {bool owned=false;~Apartment(){if(owned)RoUninitialize();}} apartment;
    std::mutex mutex;HWND owner;DWORD uiThread=GetCurrentThreadId();int width,height,capacityWidth,capacityHeight,padding=0;
    bool includeAdjacent=false,preferDxgi=true,historyValid=false,pointerReady=false;
    double lastLight=0,lastPointer=0,pointerX=0,pointerY=0,pointerPresence=0;
    GraphicsCaptureItem selected{nullptr};HMONITOR selectedMonitor=nullptr;
    ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;ComPtr<IDXGIAdapter1> adapter;
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice bridge{nullptr};
    ComPtr<ID3D11VertexShader> vertex;ComPtr<ID3D11PixelShader> lens,light,probe;
    ComPtr<ID3D11Buffer> constants,materials;ComPtr<ID3D11SamplerState> sampler;
    ComPtr<ID3D11Texture2D> atlas,lightTexture,lightHistory,probeTexture,probeReadback;
    ComPtr<ID3D11RenderTargetView> atlasTarget,lightTarget,probeTarget;
    ComPtr<ID3D11ShaderResourceView> atlasView,lightView,historyView;
    std::map<HMONITOR,std::unique_ptr<WgcTile>> wgc;
    std::map<HMONITOR,std::unique_ptr<DxgiTile>> dxgi;
    std::map<HMONITOR,double> retryAfter;
    Presenter presenter;Slot slots[3];int pending=-1,current=-1;DG_Stats stats{};
    Renderer(HWND host,int w,int h):owner(host),width(w),height(h),capacityWidth(w),capacityHeight(h){}
    ~Renderer(){
        wgc.clear();dxgi.clear();if(context){context->ClearState();context->Flush();}
        selected=nullptr;bridge=nullptr;
    }
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
        winrt::check_hresult(gpu->SetMaximumFrameLatency(1));
        if(!adapter){ComPtr<IDXGIAdapter> found;winrt::check_hresult(gpu->GetAdapter(&found));winrt::check_hresult(found.As(&adapter));}
        winrt::com_ptr<IInspectable> inspectable;winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(gpu.Get(),inspectable.put()));
        bridge=inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
        auto vs=Compile("VS","vs_4_0"),ps=Compile("LensPS","ps_4_0"),ls=Compile("LightPS","ps_4_0"),ts=Compile("ProbePS","ps_4_0");
        winrt::check_hresult(device->CreateVertexShader(vs->GetBufferPointer(),vs->GetBufferSize(),nullptr,&vertex));
        winrt::check_hresult(device->CreatePixelShader(ps->GetBufferPointer(),ps->GetBufferSize(),nullptr,&lens));
        winrt::check_hresult(device->CreatePixelShader(ls->GetBufferPointer(),ls->GetBufferSize(),nullptr,&light));
        winrt::check_hresult(device->CreatePixelShader(ts->GetBufferPointer(),ts->GetBufferSize(),nullptr,&probe));
        D3D11_BUFFER_DESC buffer{};buffer.ByteWidth=sizeof(DG_ShaderConstants);buffer.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        winrt::check_hresult(device->CreateBuffer(&buffer,nullptr,&constants));
        buffer.ByteWidth=sizeof(DG_MaterialConstants);winrt::check_hresult(device->CreateBuffer(&buffer,nullptr,&materials));
        D3D11_SAMPLER_DESC sampling{};sampling.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sampling.AddressU=sampling.AddressV=sampling.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;sampling.MaxLOD=D3D11_FLOAT32_MAX;
        winrt::check_hresult(device->CreateSamplerState(&sampling,&sampler));
        Texture(10,1,DXGI_FORMAT_R32G32B32A32_FLOAT,lightTexture,lightTarget,&lightView);
        ComPtr<ID3D11RenderTargetView> historyTarget;Texture(10,1,DXGI_FORMAT_R32G32B32A32_FLOAT,lightHistory,historyTarget,&historyView);
        const float zero[4]={};context->ClearRenderTargetView(historyTarget.Get(),zero);
        Texture(4,1,DXGI_FORMAT_R32G32B32A32_FLOAT,probeTexture,probeTarget);
        D3D11_TEXTURE2D_DESC staging{};staging.Width=4;staging.Height=staging.MipLevels=staging.ArraySize=1;
        staging.Format=DXGI_FORMAT_R32G32B32A32_FLOAT;staging.SampleDesc.Count=1;staging.Usage=D3D11_USAGE_STAGING;staging.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
        winrt::check_hresult(device->CreateTexture2D(&staging,nullptr,&probeReadback));
        for(auto& slot:slots){
            Texture(width,height,DXGI_FORMAT_B8G8R8A8_UNORM,slot.texture,slot.target);
            D3D11_QUERY_DESC q{D3D11_QUERY_EVENT,0};winrt::check_hresult(device->CreateQuery(&q,&slot.done));
            q.Query=D3D11_QUERY_TIMESTAMP;winrt::check_hresult(device->CreateQuery(&q,&slot.begin));winrt::check_hresult(device->CreateQuery(&q,&slot.end));
            q.Query=D3D11_QUERY_TIMESTAMP_DISJOINT;winrt::check_hresult(device->CreateQuery(&q,&slot.disjoint));
        }
        winrt::check_bool(SetWindowDisplayAffinity(owner,WDA_EXCLUDEFROMCAPTURE));presenter.Init(device.Get(),owner,width,height);
    }
    void ResetFrames(){
        wgc.clear();dxgi.clear();retryAfter.clear();historyValid=false;pending=current=-1;
        for(auto& slot:slots)slot.state=0;presenter.hasFrame=false;ShowWindow(presenter.window,SW_HIDE);
    }
    bool Complete(){
        winrt::check_hresult(device->GetDeviceRemovedReason());
        if(pending<0)return true;auto& slot=slots[pending];
        HRESULT hr=context->GetData(slot.done.Get(),nullptr,0,D3D11_ASYNC_GETDATA_DONOTFLUSH);
        if(hr==S_FALSE)return false;winrt::check_hresult(hr);
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT duration{};UINT64 begin=0,end=0;
        if(context->GetData(slot.disjoint.Get(),&duration,sizeof(duration),0)==S_OK&&!duration.Disjoint&&duration.Frequency&&
           context->GetData(slot.begin.Get(),&begin,sizeof(begin),0)==S_OK&&context->GetData(slot.end.Get(),&end,sizeof(end),0)==S_OK&&end>=begin)
            slot.gpuMs=double(end-begin)*1000/double(duration.Frequency);
        if(slot.probeCount){
            D3D11_MAPPED_SUBRESOURCE mapped{};
            HRESULT probeResult=context->Map(probeReadback.Get(),0,D3D11_MAP_READ,D3D11_MAP_FLAG_DO_NOT_WAIT,&mapped);
            if(probeResult!=DXGI_ERROR_WAS_STILL_DRAWING){
                winrt::check_hresult(probeResult);auto values=static_cast<const float*>(mapped.pData);
                for(unsigned i=0;i<slot.probeCount;++i)stats.probe_luminance[i]=std::clamp(values[i*4],0.f,1.f);
                context->Unmap(probeReadback.Get(),0);stats.probe_readback_bytes+=64;
            }
        }
        for(auto& old:slots)if(old.state==2)old.state=0;
        if(slot.state!=4)slot.state=2;
        stats.gpu_ms=slot.gpuMs;pending=-1;++stats.completed;return true;
    }
    std::unique_ptr<DxgiTile> CreateDxgi(HMONITOR monitor){
        for(UINT i=0;;++i){
            ComPtr<IDXGIOutput> output;if(adapter->EnumOutputs(i,&output)==DXGI_ERROR_NOT_FOUND)break;
            DXGI_OUTPUT_DESC desc{};if(FAILED(output->GetDesc(&desc))||desc.Monitor!=monitor)continue;
            // Duplication exposes unrotated pixels. Let WGC supply display-oriented pixels.
            if(desc.Rotation!=DXGI_MODE_ROTATION_IDENTITY){stats.last_capture_error=DXGI_ERROR_UNSUPPORTED;return nullptr;}
            ComPtr<IDXGIOutput1> output1;winrt::check_hresult(output.As(&output1));
            auto tile=std::make_unique<DxgiTile>();HRESULT hr=output1->DuplicateOutput(device.Get(),&tile->duplication);
            if(FAILED(hr)){stats.last_capture_error=hr;return nullptr;}
            tile->width=desc.DesktopCoordinates.right-desc.DesktopCoordinates.left;tile->height=desc.DesktopCoordinates.bottom-desc.DesktopCoordinates.top;
            D3D11_TEXTURE2D_DESC image{};image.Width=tile->width;image.Height=tile->height;image.MipLevels=image.ArraySize=1;
            image.Format=DXGI_FORMAT_B8G8R8A8_UNORM;image.SampleDesc.Count=1;
            winrt::check_hresult(device->CreateTexture2D(&image,nullptr,&tile->texture));return tile;
        }
        stats.last_capture_error=DXGI_ERROR_NOT_FOUND;return nullptr;
    }
    bool Capture(Piece const& piece,RECT region,double& oldest){
        RECT intersection{};if(!IntersectRect(&intersection,&region,&piece.bounds))return true;
        int sx=intersection.left-piece.bounds.left,sy=intersection.top-piece.bounds.top;
        int w=intersection.right-intersection.left,h=intersection.bottom-intersection.top;
        ID3D11Texture2D* source=nullptr;double sourceTime=0;
        if(preferDxgi&&retryAfter[piece.monitor]<=Now()){
            auto& tile=dxgi[piece.monitor];if(!tile)tile=CreateDxgi(piece.monitor);
            if(tile){
                ComPtr<IDXGIResource> resource;DXGI_OUTDUPL_FRAME_INFO info{};
                HRESULT hr=tile->duplication->AcquireNextFrame(0,&info,&resource);
                if(SUCCEEDED(hr)){
                    if(info.LastPresentTime.QuadPart>0){ComPtr<ID3D11Texture2D> texture;
                        HRESULT cast=resource.As(&texture);if(FAILED(cast)){tile->duplication->ReleaseFrame();winrt::check_hresult(cast);}
                        context->CopyResource(tile->texture.Get(),texture.Get());tile->timestamp=QpcTime(info.LastPresentTime.QuadPart);tile->valid=true;++stats.captured;}
                    tile->duplication->ReleaseFrame();
                }else if(hr!=DXGI_ERROR_WAIT_TIMEOUT){stats.last_capture_error=hr;tile.reset();}
                if(tile){
                    if(!tile->valid)return false;
                    if(sx+w>tile->width||sy+h>tile->height)winrt::throw_hresult(E_BOUNDS);
                    source=tile->texture.Get();sourceTime=tile->timestamp;stats.backend=1;
                }
            }
            if(!tile)retryAfter[piece.monitor]=Now()+5;
        }
        if(!source){
            auto& tile=wgc[piece.monitor];
            if(!tile){
                GraphicsCaptureItem item=selected;
                if(piece.monitor!=selectedMonitor){auto factory=winrt::get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
                    winrt::check_hresult(factory->CreateForMonitor(piece.monitor,winrt::guid_of<GraphicsCaptureItem>(),winrt::put_abi(item)));}
                tile=std::make_unique<WgcTile>();tile->Init(item,bridge);
            }
            try{if(!tile->Update(stats.captured))return false;}
            catch(winrt::hresult_error const& error){if(error.code()==DXGI_ERROR_MODE_CHANGE_IN_PROGRESS){tile.reset();return false;}throw;}
            if(sx+w>tile->width||sy+h>tile->height)winrt::throw_hresult(E_BOUNDS);
            source=tile->texture.Get();sourceTime=tile->timestamp;stats.backend=2;
        }
        D3D11_BOX box{};box.left=sx;box.top=sy;box.right=sx+w;box.bottom=sy+h;box.back=1;
        context->CopySubresourceRegion(atlas.Get(),0,intersection.left-region.left,intersection.top-region.top,0,source,0,&box);
        oldest=std::min(oldest,sourceTime);return true;
    }
    HRESULT Render(int x,int y,DG_Parameters const& p){
        const double renderStart=Now();
        DpiScope dpi;if(!selected||!presenter.visible)return S_FALSE;if(!Complete())return S_FALSE;
        int free=-1;for(int i=0;i<3;++i)if(slots[i].state==0){free=i;break;}if(free<0)return S_FALSE;
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
        ID3D11ShaderResourceView* empty[3]={};context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
        if(!atlas||padding!=halo){atlas.Reset();atlasTarget.Reset();atlasView.Reset();padding=halo;
            Texture(capacityWidth+2*halo,capacityHeight+2*halo,DXGI_FORMAT_B8G8R8A8_UNORM,atlas,atlasTarget,&atlasView);historyValid=false;}
        RECT region{x-halo,y-halo,x+width+halo,y+height+halo};std::vector<Piece> pieces;
        if(includeAdjacent){winrt::check_bool(EnumDisplayMonitors(nullptr,&region,Enumerate,reinterpret_cast<LPARAM>(&pieces)));}
        else{MONITORINFO info{sizeof(info)};winrt::check_bool(GetMonitorInfoW(selectedMonitor,&info));pieces.push_back({selectedMonitor,info.rcMonitor});}
        if(pieces.empty())return S_FALSE;
        auto active=[&](HMONITOR m){return std::any_of(pieces.begin(),pieces.end(),[&](auto const& q){return q.monitor==m;});};
        for(auto it=wgc.begin();it!=wgc.end();)if(!active(it->first))it=wgc.erase(it);else++it;
        for(auto it=dxgi.begin();it!=dxgi.end();)if(!active(it->first))it=dxgi.erase(it);else++it;
        const float zero[4]={};context->ClearRenderTargetView(atlasTarget.Get(),zero);double start=Now(),oldest=1e30;
        for(auto const& piece:pieces)if(!Capture(piece,region,oldest))return S_FALSE;
        if(oldest==1e30)return S_FALSE;stats.capture_ms=(Now()-start)*1000;
        DG_ShaderConstants data{};
        data.viewport[0]=float(width);data.viewport[1]=float(height);data.viewport[2]=p.dpi_scale;data.viewport[3]=float(halo);
        data.optics[0]=p.corner_radius_dip<0?std::min(width,height)*.5f:std::clamp(p.corner_radius_dip*p.dpi_scale,0.f,std::min(width,height)*.5f);
        data.optics[1]=p.bezel_dip*p.dpi_scale;data.optics[2]=p.thickness_dip*p.dpi_scale;data.optics[3]=p.refraction_index;
        data.appearance[0]=p.refraction_strength;data.appearance[1]=p.tint;data.appearance[2]=p.highlight_strength;data.appearance[3]=p.sensing_radius_dip;
        data.shape[0]=p.shape_x_px;data.shape[1]=p.shape_y_px;data.shape[2]=p.pressure;
        data.shape[3]=float(p.material_count);data.history[2]=float(capacityWidth+2*halo);data.history[3]=float(capacityHeight+2*halo);
        double now=Now(),dt=std::clamp(now-lastLight,0.,.1);data.history[0]=float(1-std::exp(-dt/.020));data.history[1]=historyValid?1.f:0.f;
        // Small translations retain temporal filtering; clearing it on every
        // pixel amplifies capture noise into slow-drag flicker. Reset jumps.
        if(current>=0){auto const& prior=slots[current];
            float jump=std::max(32.f,p.sensing_radius_dip*.5f)*p.dpi_scale;
            if(std::abs(prior.x-x)>jump||std::abs(prior.y-y)>jump||
               std::abs(prior.width-width)>jump||std::abs(prior.height-height)>jump)data.history[1]=0;}
        if(data.history[1]<.5f)++stats.light_history_resets;
        lastLight=now;historyValid=true;double pointerBlend=1-std::exp(-std::clamp(now-lastPointer,0.,.1)/.025);lastPointer=now;
        if(!pointerReady){pointerX=p.pointer_screen_x_px;pointerY=p.pointer_screen_y_px;pointerReady=true;}
        pointerX+=(p.pointer_screen_x_px-pointerX)*pointerBlend;pointerY+=(p.pointer_screen_y_px-pointerY)*pointerBlend;
        pointerPresence+=(std::clamp(p.pointer_presence,0.f,1.f)-pointerPresence)*pointerBlend;
        data.pointer[0]=float(pointerX-x);data.pointer[1]=float(pointerY-y);data.pointer[2]=float(pointerPresence);
        for(unsigned i=0;i<4;++i){float* probes=i<2?data.probes01:data.probes23;unsigned offset=(i%2)*2;
            if(!std::isfinite(p.probes[i].x)||!std::isfinite(p.probes[i].y))return E_INVALIDARG;
            probes[offset]=p.probes[i].x;probes[offset+1]=p.probes[i].y;}
        auto& slot=slots[free];slot.x=x;slot.y=y;slot.width=width;slot.height=height;slot.serial=++stats.submitted;slot.sourceTime=oldest;slot.submittedAt=renderStart;slot.state=1;slot.gpuMs=0;
        context->Begin(slot.disjoint.Get());context->End(slot.begin.Get());context->UpdateSubresource(constants.Get(),0,nullptr,&data,0,0);
        context->UpdateSubresource(materials.Get(),0,nullptr,&materialData,0,0);
        ID3D11Buffer* buffers[2]={constants.Get(),materials.Get()};ID3D11SamplerState* sample=sampler.Get();
        context->VSSetShader(vertex.Get(),nullptr,0);context->PSSetConstantBuffers(0,2,buffers);context->PSSetSamplers(0,1,&sample);
        context->IASetInputLayout(nullptr);context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        D3D11_VIEWPORT lightViewport{0,0,10,1,0,1};context->RSSetViewports(1,&lightViewport);
        ID3D11RenderTargetView* lightOut=lightTarget.Get();context->OMSetRenderTargets(1,&lightOut,nullptr);
        ID3D11ShaderResourceView* source=atlasView.Get();context->PSSetShaderResources(0,1,&source);
        ID3D11ShaderResourceView* previous=historyView.Get();context->PSSetShaderResources(2,1,&previous);
        context->PSSetShader(light.Get(),nullptr,0);context->Draw(3,0);context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
        context->CopyResource(lightHistory.Get(),lightTexture.Get());
        D3D11_VIEWPORT viewport{0,0,float(width),float(height),0,1};context->RSSetViewports(1,&viewport);
        ID3D11RenderTargetView* output=slot.target.Get();context->OMSetRenderTargets(1,&output,nullptr);
        ID3D11ShaderResourceView* views[2]={atlasView.Get(),lightView.Get()};context->PSSetShaderResources(0,2,views);
        context->PSSetShader(lens.Get(),nullptr,0);context->Draw(3,0);context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
        bool readProbe=p.probe_count&&(stats.submitted==1||stats.submitted%p.probe_interval==0);
        slot.probeCount=readProbe?p.probe_count:0;
        if(readProbe){
            D3D11_VIEWPORT probeViewport{0,0,4,1,0,1};context->RSSetViewports(1,&probeViewport);ID3D11RenderTargetView* out=probeTarget.Get();
            context->OMSetRenderTargets(1,&out,nullptr);context->PSSetShaderResources(0,1,&source);
            context->PSSetShader(probe.Get(),nullptr,0);context->Draw(3,0);context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
            context->CopyResource(probeReadback.Get(),probeTexture.Get());
        }
        context->End(slot.end.Get());context->End(slot.disjoint.Get());context->End(slot.done.Get());context->Flush();
        pending=free;return S_OK;
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
    if(!p)return E_POINTER;return Boundary([&]{auto& r=Object(handle);std::lock_guard guard(r.mutex);return r.Render(x,y,*p);});
}
HRESULT __cdecl DG_RenderViewport(DG_Handle handle,int x,int y,int width,int height,const DG_Parameters* p){
    if(!p)return E_POINTER;return Boundary([&]{auto& r=Object(handle);std::lock_guard guard(r.mutex);
        if(width<1||height<1||width>r.capacityWidth||height>r.capacityHeight)return E_INVALIDARG;
        r.width=width;r.height=height;return r.Render(x,y,*p);});
}
HRESULT __cdecl DG_Present(DG_Handle handle){return Boundary([&]{auto& r=Object(handle);r.RequireUi();
    std::unique_lock guard(r.mutex,std::try_to_lock);if(!guard.owns_lock())return S_FALSE;
    // Copy and Present use the same immediate GPU queue as Draw. Their ordering
    // already protects the texture; a CPU fence here adds a whole timer tick.
    r.Complete();int ready=-1;for(int i=0;i<3;++i)if((r.slots[i].state==1||r.slots[i].state==2)&&(ready<0||r.slots[i].serial>r.slots[ready].serial))ready=i;
    if(ready<0)return S_FALSE;auto& slot=r.slots[ready];HRESULT hr=r.presenter.Present(r.context.Get(),slot.texture.Get(),slot.x,slot.y,slot.width,slot.height);
    if(hr!=S_OK)return hr;if(r.current>=0)r.slots[r.current].state=0;r.current=ready;slot.state=4;
    ++r.stats.presented;r.stats.source_age_ms=std::max(0.,(Now()-slot.sourceTime)*1000);
    r.stats.render_to_present_ms=(Now()-slot.submittedAt)*1000;
    r.stats.presented_x_px=slot.x;r.stats.presented_y_px=slot.y;r.stats.presented_width_px=slot.width;r.stats.presented_height_px=slot.height;return S_OK;});}
HRESULT __cdecl DG_SetVisible(DG_Handle handle,BOOL visible){return Boundary([&]{auto& r=Object(handle);r.RequireUi();std::lock_guard guard(r.mutex);
    r.presenter.visible=visible!=FALSE;if(!visible)r.ResetFrames();return S_OK;});}
HRESULT __cdecl DG_GetStats(DG_Handle handle,DG_Stats* stats){if(!stats)return E_POINTER;return Boundary([&]{auto& r=Object(handle);std::lock_guard guard(r.mutex);*stats=r.stats;return S_OK;});}
HRESULT __cdecl DG_TryGetStats(DG_Handle handle,DG_Stats* stats){if(!stats)return E_POINTER;return Boundary([&]{auto& r=Object(handle);
    std::unique_lock guard(r.mutex,std::try_to_lock);if(!guard.owns_lock())return S_FALSE;*stats=r.stats;return S_OK;});}
HWND __cdecl DG_GetCompositionWindow(DG_Handle handle){if(!handle)return nullptr;auto& r=Object(handle);std::lock_guard guard(r.mutex);return r.presenter.window;}
HRESULT __cdecl DG_ExcludeWindowFromCapture(HWND window){return SetWindowDisplayAffinity(window,WDA_EXCLUDEFROMCAPTURE)?S_OK:HRESULT_FROM_WIN32(GetLastError());}
void __cdecl DG_LastError(char* destination,int capacity){if(!destination||capacity<1)return;size_t n=std::min(diagnostic.size(),size_t(capacity-1));std::memcpy(destination,diagnostic.data(),n);destination[n]=0;}
