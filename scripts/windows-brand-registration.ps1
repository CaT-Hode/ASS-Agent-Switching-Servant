$ErrorActionPreference = 'Stop'
$spec = ConvertFrom-Json $env:ASS_BRAND_SPEC
if ($spec.AppId -ne 'local.ass.desktop') { throw 'Unexpected ASS app identity' }
$releaseRoot = [IO.Path]::GetFullPath($spec.ReleaseRoot).TrimEnd('\')
$exe = [IO.Path]::GetFullPath($spec.Executable)
$icon = [IO.Path]::GetFullPath($spec.Icon)
$iconRelative = $icon.Substring([Math]::Min($icon.Length, $releaseRoot.Length + 1))
$ownedIcon = $icon.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and
    ($iconRelative -match '^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\\ASS-win32-x64\\resources\\ass\.ico$')
$pinnedExe = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($icon))) 'ASS.exe'
$ownedExe = $exe -eq "$releaseRoot\current\ASS.exe" -or $exe -eq $pinnedExe
if (!$ownedExe -or !$ownedIcon -or
    !(Test-Path -LiteralPath $exe -PathType Leaf) -or !(Test-Path -LiteralPath $icon -PathType Leaf)) {
    throw 'Unexpected or missing ASS executable/icon'
}
$appId = 'HKCU:\Software\Classes\AppUserModelId\local.ass.desktop'
$appPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\ASS.exe'
$application = 'HKCU:\Software\Classes\Applications\ASS.exe'
$defaultIcon = "$application\DefaultIcon"
$entries = @(
    @{ Key=$appId; Name='DisplayName'; Value='ASS' },
    @{ Key=$appId; Name='IconUri'; Value=$icon },
    @{ Key=$appPath; Name=''; Value=$exe },
    @{ Key=$appPath; Name='Path'; Value=[IO.Path]::GetDirectoryName($exe) },
    @{ Key=$application; Name='FriendlyAppName'; Value='ASS' },
    @{ Key=$defaultIcon; Name=''; Value="$icon,0" }
)
# Preserve the startup preference. Update only an existing, plain ASS command;
# never enable startup, alter approval state, or execute the stored command.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path -LiteralPath $runKey) {
    $runValue = (Get-Item -LiteralPath $runKey).GetValue('ASS', $null)
    if ($null -ne $runValue) {
        if ([string]$runValue -notmatch '^(?:"([^"]+)"|([^\s"]+))( --hidden)?$') { throw 'Refusing custom ASS startup command' }
        $runExe = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        $runSuffix = $Matches[3]
        $runRelative = $runExe.Substring([Math]::Min($runExe.Length, $releaseRoot.Length + 1))
        if (!$runExe.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $runRelative -notmatch '^(?:current|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\\ASS-win32-x64)\\ASS\.exe$') {
            throw 'Refusing foreign ASS startup command'
        }
        $entries += @{ Key=$runKey; Name='ASS'; Value=('"' + $exe + '"' + $runSuffix) }
    }
}
$before = @(); $created = @()
foreach ($entry in $entries) {
    $keyExists = Test-Path -LiteralPath $entry.Key
    $prior = if ($keyExists) { (Get-Item -LiteralPath $entry.Key).GetValue($entry.Name, $null) } else { $null }
    if ($null -ne $prior -and $entry.Name -in @('IconUri', 'Path', '') -and
        !([string]$prior).Trim('"').StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing foreign ASS registry entry: $($entry.Key)"
    }
    if ($null -ne $prior -and $entry.Name -in @('DisplayName', 'FriendlyAppName') -and $prior -ne 'ASS') {
        throw "Refusing foreign ASS display name: $($entry.Key)"
    }
    $before += @{Key=$entry.Key;Name=$entry.Name;Value=$prior}
}
# Backup only these scoped ASS values, not the user's registry or credentials.
$backup = Join-Path $releaseRoot ('brand-registry-before-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.xml')
$before | Export-Clixml -LiteralPath $backup
try {
    foreach ($entry in $entries) {
        if (!(Test-Path -LiteralPath $entry.Key)) { New-Item -Path $entry.Key -Force | Out-Null; $created += $entry.Key }
        # Get-Item returns a read-only RegistryKey; open an explicit writable
        # HKCU handle rather than invoking SetValue on the provider's handle.
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($entry.Key.Substring(6), $true)
        try {
            $key.SetValue($entry.Name, $entry.Value, [Microsoft.Win32.RegistryValueKind]::String)
            if ($key.GetValue($entry.Name) -ne $entry.Value) { throw 'ASS registry icon readback mismatch' }
        } finally { $key.Dispose() }
    }
} catch {
    foreach ($entry in $before) {
        if (Test-Path -LiteralPath $entry.Key) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($entry.Key.Substring(6), $true)
            try {
                if ($null -eq $entry.Value) { $key.DeleteValue($entry.Name, $false) } else { $key.SetValue($entry.Name, $entry.Value) }
            } finally { $key.Dispose() }
        }
    }
    # Delete only empty keys created by this invocation, never pre-existing keys.
    [array]::Reverse($created)
    foreach ($keyPath in $created) {
        $key = Get-Item -LiteralPath $keyPath
        if (!$key.ValueCount -and !$key.SubKeyCount) { Remove-Item -LiteralPath $keyPath }
    }
    throw
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AssBrandRefresh {
    [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
# Ask Explorer to refresh icons without killing Explorer or any harness.
[AssBrandRefresh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
