#include <windows.h>
#include <delayimp.h>
#include <cstring>
// The standard node-gyp delay-load pattern: Electron and packaged ASS rename
// the Node host executable. Resolve N-API imports from that running image.
static FARPROC WINAPI Host(unsigned int event, DelayLoadInfo* info) {
    if(event!=dliNotePreLoadLibrary||_stricmp(info->szDll,"node.exe")!=0)return nullptr;
    HMODULE module=GetModuleHandleW(L"libnode.dll");if(!module)module=GetModuleHandleW(nullptr);
    return reinterpret_cast<FARPROC>(module);
}
decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2=Host;
