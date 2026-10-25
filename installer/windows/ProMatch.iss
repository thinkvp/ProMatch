; ProMatch installer for Windows (Inno Setup 6). Build with `npm run package:win`,
; which stages the files and passes AppVersion, StageDir, OutputDir and Signed.
;
; Installs for all users (needs admin, because the effect goes under Program Files):
;   panel  -> C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\ProMatch
;   effect -> C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\ProMatch\ProMatch.aex
; User data in %APPDATA%\ProMatch and the LUTs beside projects are left alone.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\release\stage"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\release"
#endif
#ifndef Signed
  #define Signed "0"
#endif

[Setup]
AppId={{B709B640-B132-4F0A-B237-1D2F497B31C4}
AppName=ProMatch
AppVersion={#AppVersion}
AppVerName=ProMatch {#AppVersion}
AppPublisher=ThinkVP
AppPublisherURL=https://github.com/thinkvp/ProMatch-releases
AppUpdatesURL=https://github.com/thinkvp/ProMatch-releases/releases/latest
DefaultDirName={commoncf32}\Adobe\CEP\extensions\ProMatch
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile={#StageDir}\EULA.txt
OutputDir={#OutputDir}
OutputBaseFilename=ProMatch-{#AppVersion}-win-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=ProMatch {#AppVersion} for Premiere Pro
; Replaces files Premiere or Media Encoder might hold open.
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#StageDir}\panel\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StageDir}\effect\ProMatch.aex"; DestDir: "{commonpf64}\Adobe\Common\Plug-ins\7.0\MediaCore\ProMatch"; Flags: ignoreversion
Source: "{#StageDir}\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\EULA.txt"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; Leftovers from older versions whose file lists differ.
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\vendor"

[UninstallDelete]
Type: dirifempty; Name: "{commonpf64}\Adobe\Common\Plug-ins\7.0\MediaCore\ProMatch"

#if Signed == "0"
[Registry]
; Unsigned dev build only: let CEP load an unsigned panel (Premiere 2021-2026 = CSXS 9-12).
Root: HKCU; Subkey: "Software\Adobe\CSXS.9"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
#endif

[Messages]
FinishedLabel=ProMatch is installed.%n%nStart Premiere Pro and open Window > Extensions > ProMatch. The ProMatch effect is under Video Effects > ProMatch.

[Code]
function IsRunning(const ExeName: String): Boolean;
var
  Locator, Service, Found: Variant;
begin
  Result := False;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Found := Service.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name="' + ExeName + '"');
    Result := Found.Count > 0;
  except
  end;
end;

// Premiere and Media Encoder load the effect at startup and keep it locked.
function AdobeAppsClosed(): Boolean;
begin
  Result := True;
  while IsRunning('Adobe Premiere Pro.exe') or IsRunning('Adobe Media Encoder.exe') do
  begin
    if MsgBox('Please close Premiere Pro and Media Encoder, then press Retry.',
              mbError, MB_RETRYCANCEL) = IDCANCEL then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := AdobeAppsClosed();
end;

function InitializeUninstall(): Boolean;
begin
  Result := AdobeAppsClosed();
end;
