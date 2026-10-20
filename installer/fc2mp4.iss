; fc2mp4 for Windows: the window (fc2mp4.exe) and the command-line tool (fc2mp4-cli.exe), per user.
; Built by CI: ISCC /DAppVersion=<version> installer\fc2mp4.iss, with both exes in build\installer\.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
; Never change AppId: it is how a new setup finds and updates an existing install.
AppId={{2F6C3B7E-9A41-4C55-8E2D-6B1F0C9D4A17}
AppName=fc2mp4
AppVersion={#AppVersion}
AppVerName=fc2mp4 {#AppVersion}
AppPublisher=Coccis
AppPublisherURL=https://github.com/Coccis77/fightcade-replay-converter
AppSupportURL=https://github.com/Coccis77/fightcade-replay-converter/issues
DefaultDirName={localappdata}\Programs\fc2mp4
UsePreviousAppDir=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\build
OutputBaseFilename=fc2mp4-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\fc2mp4.exe
SetupIconFile=..\assets\fc2mp4.ico
UninstallDisplayName=fc2mp4

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\build\installer\fc2mp4.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\installer\fc2mp4-cli.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\fc2mp4"; Filename: "{app}\fc2mp4.exe"
Name: "{autodesktop}\fc2mp4"; Filename: "{app}\fc2mp4.exe"; Tasks: desktopicon

[Run]
; Also after a silent install, so "Update now" reopens the window. /nolaunch=1 (CI) skips it.
; Through Explorer, as if from the Start menu: a window started directly by Setup inherits something
; from it that makes the emulator exit at once ("The emulator exited before the replay started",
; seen on Windows 2026-10-18); a restart from the Start menu fixed it.
Filename: "{win}\explorer.exe"; Parameters: """{app}\fc2mp4.exe"""; Description: "Launch fc2mp4"; Flags: nowait postinstall; Check: ShouldLaunch

[Code]
function ShouldLaunch: Boolean;
begin
  Result := ExpandConstant('{param:nolaunch|0}') = '0';
end;

function InstalledVersion: String;
begin
  if not RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{2F6C3B7E-9A41-4C55-8E2D-6B1F0C9D4A17}_is1', 'DisplayVersion', Result) then
    Result := '';
end;

function InitializeSetup: Boolean;
var
  Installed: String;
  InstalledPacked, NewPacked: Int64;
begin
  Result := True;
  Installed := InstalledVersion;
  if (Installed <> '') and StrToVersion(Installed, InstalledPacked) and StrToVersion('{#AppVersion}', NewPacked) then
    if ComparePackedVersion(InstalledPacked, NewPacked) > 0 then
      Result := SuppressibleMsgBox('A newer version of fc2mp4 is already installed (v' + Installed + '). Install v{#AppVersion} anyway?',
        mbConfirmation, MB_YESNO, IDNO) = IDYES;
end;

procedure InitializeWizard;
begin
  if InstalledVersion <> '' then
    WizardForm.Caption := 'Updating fc2mp4 to v{#AppVersion}';
end;
