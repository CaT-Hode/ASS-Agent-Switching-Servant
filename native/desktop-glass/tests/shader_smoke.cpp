#include "DesktopGlass.h"
#include "GlassShader.h"
#include <d3d11.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <cmath>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace {
void Check(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
void Hr(HRESULT result){if(FAILED(result))throw std::runtime_error("D3D HRESULT "+std::to_string(static_cast<unsigned long>(result)));}
struct Image {ComPtr<ID3D11Texture2D> texture;ComPtr<ID3D11ShaderResourceView> view;};
struct Fixture {
    ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;ComPtr<ID3D11VertexShader> vertex;
    ComPtr<ID3D11Buffer> constants,materials;ComPtr<ID3D11SamplerState> sampler;
    Fixture(){
        Hr(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_WARP,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context));
        auto code=Compile("VS","vs_4_0");Hr(device->CreateVertexShader(code->GetBufferPointer(),code->GetBufferSize(),nullptr,&vertex));
        D3D11_BUFFER_DESC cb{};cb.ByteWidth=sizeof(DG_ShaderConstants);cb.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        Hr(device->CreateBuffer(&cb,nullptr,&constants));
        cb.ByteWidth=sizeof(DG_MaterialConstants);Hr(device->CreateBuffer(&cb,nullptr,&materials));
        D3D11_SAMPLER_DESC sample{};sample.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sample.AddressU=sample.AddressV=sample.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;sample.MaxLOD=D3D11_FLOAT32_MAX;
        Hr(device->CreateSamplerState(&sample,&sampler));
    }
    ComPtr<ID3DBlob> Compile(const char* entry,const char* profile,const char* extra=""){
        std::string source=std::string(DG_Shader)+extra;ComPtr<ID3DBlob> code,error;
        HRESULT hr=D3DCompile(source.data(),source.size(),"synthetic-glass-test",nullptr,nullptr,entry,profile,
            D3DCOMPILE_ENABLE_STRICTNESS|D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&code,&error);
        if(FAILED(hr)&&error)std::cerr<<static_cast<const char*>(error->GetBufferPointer());Hr(hr);return code;
    }
    Image Upload(int width,int height,std::vector<float> const& pixels){
        Image result;D3D11_TEXTURE2D_DESC desc{};desc.Width=width;desc.Height=height;desc.MipLevels=desc.ArraySize=1;
        desc.Format=DXGI_FORMAT_R32G32B32A32_FLOAT;desc.SampleDesc.Count=1;desc.BindFlags=D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA data{pixels.data(),UINT(width*4*sizeof(float)),0};
        Hr(device->CreateTexture2D(&desc,&data,&result.texture));Hr(device->CreateShaderResourceView(result.texture.Get(),nullptr,&result.view));return result;
    }
    std::vector<float> Draw(const char* entry,int width,int height,DG_ShaderConstants const& params,
        ID3D11ShaderResourceView* desktop=nullptr,ID3D11ShaderResourceView* lighting=nullptr,ID3D11ShaderResourceView* history=nullptr,const char* extra="",DG_MaterialConstants const* materialData=nullptr){
        auto code=Compile(entry,"ps_4_0",extra);ComPtr<ID3D11PixelShader> pixel;
        Hr(device->CreatePixelShader(code->GetBufferPointer(),code->GetBufferSize(),nullptr,&pixel));
        D3D11_TEXTURE2D_DESC desc{};desc.Width=width;desc.Height=height;desc.MipLevels=desc.ArraySize=1;
        desc.Format=DXGI_FORMAT_R32G32B32A32_FLOAT;desc.SampleDesc.Count=1;desc.BindFlags=D3D11_BIND_RENDER_TARGET;
        ComPtr<ID3D11Texture2D> output;ComPtr<ID3D11RenderTargetView> target;
        Hr(device->CreateTexture2D(&desc,nullptr,&output));Hr(device->CreateRenderTargetView(output.Get(),nullptr,&target));
        DG_MaterialConstants emptyMaterials{};
        context->UpdateSubresource(materials.Get(),0,nullptr,materialData?materialData:&emptyMaterials,0,0);
        context->UpdateSubresource(constants.Get(),0,nullptr,&params,0,0);ID3D11Buffer* cb[2]={constants.Get(),materials.Get()};ID3D11SamplerState* sm=sampler.Get();
        context->VSSetShader(vertex.Get(),nullptr,0);context->PSSetShader(pixel.Get(),nullptr,0);
        context->PSSetConstantBuffers(0,2,cb);context->PSSetSamplers(0,1,&sm);
        ID3D11ShaderResourceView* inputs[3]={desktop,lighting,history};context->PSSetShaderResources(0,3,inputs);
        context->IASetInputLayout(nullptr);context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        D3D11_VIEWPORT viewport{0,0,float(width),float(height),0,1};context->RSSetViewports(1,&viewport);
        ID3D11RenderTargetView* out=target.Get();context->OMSetRenderTargets(1,&out,nullptr);context->Draw(3,0);
        ID3D11ShaderResourceView* empty[3]={};context->PSSetShaderResources(0,3,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
        desc.BindFlags=0;desc.Usage=D3D11_USAGE_STAGING;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> staging;Hr(device->CreateTexture2D(&desc,nullptr,&staging));context->CopyResource(staging.Get(),output.Get());
        D3D11_MAPPED_SUBRESOURCE mapped{};Hr(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped));
        std::vector<float> result(size_t(width)*height*4);
        for(int y=0;y<height;++y)std::memcpy(result.data()+size_t(y)*width*4,static_cast<const char*>(mapped.pData)+size_t(y)*mapped.RowPitch,size_t(width)*4*sizeof(float));
        context->Unmap(staging.Get(),0);return result;
    }
};
}
int main(){try{
    DG_Parameters defaults{};DG_DefaultParameters(&defaults);
    Check(defaults.probe_count==0,"probes must be opt-in");
    Check(defaults.refraction_index>1&&defaults.refraction_strength>0,"refractive defaults");
    DG_Handle invalid=nullptr;Check(DG_Create(nullptr,80,40,&invalid)==E_INVALIDARG&&!invalid,"invalid owner rejected");
    Check(DG_Render(nullptr,0,0,&defaults)==E_POINTER,"null renderer rejected");
    Fixture gpu;constexpr int width=80,height=40,halo=112,aw=width+2*halo,ah=height+2*halo;
    std::vector<float> atlas(size_t(aw)*ah*4);
    for(int y=0;y<ah;++y)for(int x=0;x<aw;++x){size_t i=(size_t(y)*aw+x)*4;
        atlas[i]=(x%11)<5?.85f:.12f;atlas[i+1]=(y%13)<6?.8f:.1f;atlas[i+2]=.3f;atlas[i+3]=1;}
    auto source=gpu.Upload(aw,ah,atlas);DG_ShaderConstants params{};
    params.viewport[0]=width;params.viewport[1]=height;params.viewport[2]=1;params.viewport[3]=halo;
    params.optics[0]=height*.5f;params.optics[1]=16;params.optics[2]=120;params.optics[3]=1.5f;
    params.appearance[3]=96;params.history[0]=1;params.history[1]=0;
    auto lit=gpu.Draw("LightPS",10,1,params,source.view.Get());auto light=gpu.Upload(10,1,lit);
    for(float value:lit)Check(std::isfinite(value),"lighting must stay finite");
    auto flat=gpu.Draw("LensPS",width,height,params,source.view.Get(),light.view.Get());
    Check(flat[(5*width+5)*4+3]>.99f,"continuous corner shoulder must extend beyond the circular arc");
    DG_MaterialConstants local{};local.rect[0][0]=24;local.rect[0][1]=8;local.rect[0][2]=32;local.rect[0][3]=24;
    local.grid[0][0]=local.grid[0][1]=1;local.surface[0][0]=4;local.surface[0][1]=3;
    params.shape[3]=1;auto frosted=gpu.Draw("LensPS",width,height,params,source.view.Get(),light.view.Get(),nullptr,"",&local);params.shape[3]=0;
    size_t localCenter=(size_t(20)*width+40)*4,outside=(size_t(20)*width+10)*4;
    Check(std::abs(frosted[localCenter]-flat[localCenter])>.01,"local material must blur the actual desktop texture");
    for(int c=0;c<3;++c)Check(std::abs(frosted[outside+c]-flat[outside+c])<1e-5,"background outside materials must stay sharp");
    params.viewport[0]=40;params.viewport[1]=20;params.history[2]=aw;params.history[3]=ah;
    auto smaller=gpu.Draw("LensPS",40,20,params,source.view.Get(),light.view.Get());
    for(int c=0;c<3;++c)Check(std::abs(smaller[(10*40+20)*4+c]-atlas[((halo+10)*aw+halo+20)*4+c])<1e-5,"resizing must preserve physical sampling within the allocated atlas");
    params.viewport[0]=width;params.viewport[1]=height;
    params.appearance[0]=.72f;
    auto refracted=gpu.Draw("LensPS",width,height,params,source.view.Get(),light.view.Get());
    Check(flat[3]==0&&refracted[3]==0,"rounded corner outside surface must stay transparent");
    size_t center=(size_t(height/2)*width+width/2)*4;
    size_t sourceCenter=(size_t(halo+height/2)*aw+halo+width/2)*4;
    for(int c=0;c<3;++c)Check(std::abs(flat[center+c]-atlas[sourceCenter+c])<1e-5,"flat background must keep raw desktop pixels sharp");
    Check(std::abs(refracted[center+3]-1)<1e-6,"surface center must be opaque");
    for(int c=0;c<4;++c)Check(std::abs(flat[center+c]-refracted[center+c])<1e-5,"refraction must not displace the flat center");
    double edgeDifference=0;
    for(int y=1;y<15;++y)for(int x=25;x<55;++x){size_t i=(size_t(y)*width+x)*4;
        if(flat[i+3]>.99f)for(int c=0;c<3;++c)edgeDifference+=std::abs(flat[i+c]-refracted[i+c]);}
    Check(edgeDifference>.01,"enabling refraction must geometrically change sampled edge pixels");
    const char* gate="\nfloat4 GatePS(Vary input):SV_TARGET {float3 c=appearance.xyz;return colorReflection(float4(c,dot(c,float3(.2126,.7152,.0722))),0);}";
    params.appearance[0]=.91f;params.appearance[1]=.94f;params.appearance[2]=1;
    auto neutral=gpu.Draw("GatePS",1,1,params,nullptr,nullptr,nullptr,gate);
    Check(neutral[3]==0,"low saturation must produce no colored highlight energy");
    params.appearance[0]=.04f;params.appearance[1]=.2f;params.appearance[2]=.95f;
    auto vivid=gpu.Draw("GatePS",1,1,params,nullptr,nullptr,nullptr,gate);
    Check(vivid[3]>.001f,"saturated scene must produce colored highlight energy");
    std::vector<float> plain(size_t(aw)*ah*4),white(size_t(aw)*ah*4,1);
    for(size_t i=0;i<plain.size();i+=4){plain[i]=.2f;plain[i+1]=.4f;plain[i+2]=.6f;plain[i+3]=1;}
    auto raw=gpu.Upload(aw,ah,plain),poison=gpu.Upload(aw,ah,white);
    for(int i=0;i<4;++i){float* positions=i<2?params.probes01:params.probes23;positions[(i%2)*2]=40;positions[(i%2)*2+1]=20;}
    auto probe=gpu.Draw("ProbePS",4,1,params,raw.view.Get(),nullptr,poison.view.Get());
    for(int i=0;i<4;++i)Check(std::abs(probe[i*4]-(.2f*.2126f+.4f*.7152f+.6f*.0722f))<1e-5,"text probe must sample raw atlas, not rendered glass/history");
    std::cout<<"PASS: C ABI defaults, all shader entries, finite light field, rounded alpha, geometric refraction, saturation gate, raw-atlas probes. No desktop capture.\n";
    return 0;
}catch(std::exception const& error){std::cerr<<"FAIL: "<<error.what()<<'\n';return 1;}}
