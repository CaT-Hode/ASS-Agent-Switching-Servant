#pragma once
#include <windows.h>
#include <unknwn.h>
#include <stdint.h>

#ifdef DESKTOP_GLASS_EXPORTS
#define DG_API __declspec(dllexport)
#else
#define DG_API __declspec(dllimport)
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef void* DG_Handle;
typedef struct DG_Point { float x, y; } DG_Point;
typedef struct DG_MaterialGrid {
    float x, y, width, height; /* viewport-local physical pixels */
    float columns, rows, gap_x, gap_y;
    float radius, blur; /* physical pixels */
} DG_MaterialGrid;
typedef struct DG_Parameters {
    float dpi_scale;
    float corner_radius_dip; /* negative: capsule */
    float bezel_dip, thickness_dip, refraction_index, refraction_strength;
    float tint, highlight_strength;
    float capture_padding_dip, sensing_radius_dip;
    float shape_x_px, shape_y_px, pressure;
    float pointer_screen_x_px, pointer_screen_y_px, pointer_presence;
    uint32_t probe_count, probe_interval;
    DG_Point probes[4]; /* local physical pixels; never composited foreground */
    uint32_t material_count;
    DG_MaterialGrid materials[2];
} DG_Parameters;

typedef struct DG_Stats {
    uint64_t submitted, completed, presented, captured;
    double capture_ms, gpu_ms, source_age_ms;
    uint64_t probe_readback_bytes;
    float probe_luminance[4];
    uint32_t backend; /* 0: waiting, 1: DXGI, 2: WGC */
    HRESULT last_capture_error;
    int presented_x_px, presented_y_px;
    double render_to_present_ms; /* CPU submit to successful DXGI Present, not display latency */
    int presented_width_px, presented_height_px;
} DG_Stats;

/* The owner HWND must remain valid. Create/source changes/Present/SetVisible/Destroy on its UI
   thread. Render may use a COM-initialized worker; join it before Destroy.
   Public operations on one handle are serialized. Stop issuing calls before
   destroying the handle. The host owns input, foreground, shadows and layout. */
/* On session lock: stop/join rendering and destroy on the UI thread. On unlock:
   recreate and reselect the SAME authorized monitor/scope. Retry transient
   creation/render/present failures with a deadline (e.g. 500ms), not a busy loop.
   Do not reuse a removed D3D device or a closed capture item after unlocking. */
DG_API void __cdecl DG_DefaultParameters(DG_Parameters* parameters);
DG_API HRESULT __cdecl DG_Create(HWND owner, int width_px, int height_px, DG_Handle* result);
DG_API HRESULT __cdecl DG_Destroy(DG_Handle handle);
/* Change the visible viewport within the capacity passed to Create. Keeps the
   capture session, device, swap chain and textures alive during size animation. */
DG_API HRESULT __cdecl DG_SetViewport(DG_Handle handle, int width_px, int height_px);

/* Call after the host/user chooses an allowed monitor. Adjacent monitors are
   included only when explicitly requested; prefer_dxgi=0 selects WGC only. */
DG_API HRESULT __cdecl DG_SelectMonitor(DG_Handle handle, HMONITOR monitor,
    BOOL include_adjacent_monitors, BOOL prefer_dxgi);
/* Optional bridge for an existing system picker. item is a borrowed
   IInspectable* for a monitor GraphicsCaptureItem; the core takes a reference.
   This route uses WGC and never expands the selected capture scope. */
DG_API HRESULT __cdecl DG_SetCaptureItem(DG_Handle handle, IUnknown* item, HMONITOR monitor);
DG_API HRESULT __cdecl DG_ClearSource(DG_Handle handle);

/* x/y are the physical desktop origin of the viewport. S_OK submits/presents a
   frame; S_FALSE means no completed/source frame or no free slot yet. */
DG_API HRESULT __cdecl DG_Render(DG_Handle handle, int x_px, int y_px, const DG_Parameters* parameters);
DG_API HRESULT __cdecl DG_Present(DG_Handle handle);
/* Hide releases active capture sessions; Show resumes the selected source. */
DG_API HRESULT __cdecl DG_SetVisible(DG_Handle handle, BOOL visible);
DG_API HRESULT __cdecl DG_GetStats(DG_Handle handle, DG_Stats* stats);
DG_API HWND __cdecl DG_GetCompositionWindow(DG_Handle handle);
DG_API HRESULT __cdecl DG_ExcludeWindowFromCapture(HWND window);
DG_API void __cdecl DG_LastError(char* destination, int capacity);

#ifdef __cplusplus
}
#endif
