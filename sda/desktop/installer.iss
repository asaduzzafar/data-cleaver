; Inno Setup script for Data Cleaver.
;
; Build from the repository root, after PyInstaller has produced
; build\dist\DataCleaver:
;
;     ISCC /DAppVersion=1.0.0 sda\desktop\installer.iss
;
; The release workflow also passes /DRepoUrl=<the repository's URL>, which
; becomes the support link in Apps & features.
;
; Output: build\installer\DataCleaver-Setup.exe
;
; Installs per user by default: no administrator prompt, which matters for
; the people this is for. Uninstalling removes the program only. Loaded
; data, saved slices and settings live in %LOCALAPPDATA%\DataCleaver, which
; the installer never touches.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#define AppName "Data Cleaver"
#define AppExe "DataCleaver.exe"
#define Root AddBackslash(SourcePath) + "..\.."

[Setup]
; Never change the AppId: upgrades and uninstall find earlier installs by it.
AppId={{6B0E4F2A-9C1D-4E57-8A3B-D2C1E0F7A915}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
#ifdef RepoUrl
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
#endif
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#Root}\build\installer
OutputBaseFilename=DataCleaver-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
; Close a running copy rather than asking for a reboot.
CloseApplications=yes
RestartApplications=no
#ifexist AddBackslash(SourcePath) + "datacleaver.ico"
SetupIconFile=datacleaver.ico
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Root}\build\dist\DataCleaver\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; PyInstaller's bytecode caches, if any were written beside the program.
Type: filesandordirs; Name: "{app}\_internal\__pycache__"

[Messages]
FinishedLabel=Setup has installed [name] on your computer.%n%nThe first launch prepares a sample dataset, which takes about half a minute.
