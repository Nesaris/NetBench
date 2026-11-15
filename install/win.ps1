# Installe Rebond (anciennement Sonde) sur Windows 10/11 (ou le met à jour ; -Uninstall pour le désinstaller).
#   irm https://raw.githubusercontent.com/Nesaris/sonde/main/install/win.ps1 | iex
# Rien n'est installé en dehors de ton profil, aucun droit administrateur n'est demandé.
# Node.js vient de nodejs.org (empreinte SHA-256 vérifiée) et Rebond des releases GitHub
# (signature Ed25519 du mainteneur vérifiée avant installation).
param([switch]$Uninstall, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:SONDE_REPO) { $env:SONDE_REPO } else { 'Nesaris/sonde' }
$PubKey = 'MCowBQYDK2VwAyEAY03Xgj+jmh+tZbBD0cI+qQuVwLH+L6/0qAGwyCFflE4='
$Root = Join-Path $env:LOCALAPPDATA 'Sonde\app'
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Rebond.lnk'
$Desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Rebond.lnk'
$Old = @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Sonde.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sonde.lnk'), (Join-Path $Root 'Sonde.vbs'), (Join-Path $Root 'Rebond.vbs'))
function Say($m) { Write-Host "› $m" -ForegroundColor Cyan }

if ($Uninstall) {
  Get-Process Rebond -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$Root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Remove-Item -Recurse -Force (@($Root, $StartMenu, $Desktop) + $Old) -ErrorAction SilentlyContinue
  Say "Rebond est désinstallé. Tes rapports et réglages restent dans $env:APPDATA\Sonde (supprime ce dossier pour tout effacer)."
  return
}

$Tmp = Join-Path $env:TEMP ("sonde-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp, (Join-Path $Root 'versions') | Out-Null
try {
  # ---------------------------------------------------------------- Node.js
  $na = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = 'https://nodejs.org/dist/latest-v22.x'
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match "node-v[0-9.]+-win-$na\.zip$" } | Select-Object -First 1
  if (-not $line) { throw 'Version de Node introuvable' }
  $sum, $file = ($line.Trim() -split '\s+')
  $marker = Join-Path $Root 'node\.file'
  if (-not (Test-Path $marker) -or (Get-Content $marker) -ne $file) {
    Say "Téléchargement de Node.js ($file)"
    $zip = Join-Path $Tmp $file
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
    if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $sum.ToLower()) { throw 'Empreinte de Node.js incorrecte : téléchargement refusé' }
    Expand-Archive -Force $zip (Join-Path $Tmp 'n')
    $inner = Get-ChildItem (Join-Path $Tmp 'n') | Select-Object -First 1
    Remove-Item -Recurse -Force (Join-Path $Root 'node') -ErrorAction SilentlyContinue
    Move-Item $inner.FullName (Join-Path $Root 'node')
    Set-Content -Path $marker -Value $file
  }
  $Node = Join-Path $Root 'node\node.exe'

  # ---------------------------------------------------------------- Sonde (paquet signé)
  Say 'Téléchargement de la dernière version de Rebond'
  $rel = Invoke-RestMethod -UseBasicParsing -Headers @{ accept = 'application/vnd.github+json' } "https://api.github.com/repos/$Repo/releases/latest"
  $ver = $rel.tag_name -replace '^v', ''
  $url = "https://github.com/$Repo/releases/download/v$ver/sonde-app-$ver.json"
  Invoke-WebRequest -UseBasicParsing $url -OutFile (Join-Path $Tmp 'app.json')
  Invoke-WebRequest -UseBasicParsing "$url.sig" -OutFile (Join-Path $Tmp 'app.json.sig')
  $env:PUB = $PubKey; $env:DEST = Join-Path $Root "versions\$ver"
  $js = @'
const c=require("crypto"),fs=require("fs"),path=require("path");
const buf=fs.readFileSync(process.argv[1]);
const pub="-----BEGIN PUBLIC KEY-----\n"+process.env.PUB+"\n-----END PUBLIC KEY-----";
if(!c.verify(null,buf,c.createPublicKey(pub),Buffer.from(fs.readFileSync(process.argv[2],"utf8").trim(),"base64"))){console.error("Signature invalide : installation annulée.");process.exit(1)}
const b=JSON.parse(buf), dest=process.env.DEST, tmp=dest+".tmp";
fs.rmSync(tmp,{recursive:true,force:true});
for(const [rel,b64] of Object.entries(b.files)){ const n=path.normalize(rel); if(path.isAbsolute(n)||n.startsWith("..")||!/^[\w./-]+$/.test(rel)) throw new Error("chemin interdit "+rel); const f=path.join(tmp,n); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,Buffer.from(b64,"base64")); }
fs.rmSync(dest,{recursive:true,force:true}); fs.renameSync(tmp,dest);
'@
  $jsFile = Join-Path $Tmp 'unpack.js'; Set-Content -Path $jsFile -Value $js -Encoding UTF8
  & $Node $jsFile (Join-Path $Tmp 'app.json') (Join-Path $Tmp 'app.json.sig')
  if ($LASTEXITCODE -ne 0) { throw 'Paquet refusé' }
  Say "Signature vérifiée (version $ver)"
  if (Test-Path (Join-Path $Root 'current')) { Copy-Item (Join-Path $Root 'current') (Join-Path $Root 'previous') -Force }
  Set-Content -Path (Join-Path $Root 'current') -Value $ver -NoNewline
  Copy-Item (Join-Path $Root "versions\$ver\launcher.js") (Join-Path $Root 'launcher.js') -Force

  # ---------------------------------------------------------------- app native (fenêtre WebView2 du système, sans navigateur)
  $exe = Join-Path $Root 'Rebond.exe'
  $nurl = "https://github.com/$Repo/releases/download/v$ver/Rebond.exe"
  $dl = Join-Path $Tmp 'Rebond.exe'
  $okExe = $false
  try {
    Invoke-WebRequest -UseBasicParsing $nurl -OutFile $dl
    Invoke-WebRequest -UseBasicParsing "$nurl.sig" -OutFile "$dl.sig"
    $vjs = Join-Path $Tmp 'verify.js'
    Set-Content -Path $vjs -Encoding UTF8 -Value 'const c=require("crypto"),fs=require("fs");const pub="-----BEGIN PUBLIC KEY-----\n"+process.env.PUB+"\n-----END PUBLIC KEY-----";process.exit(c.verify(null,fs.readFileSync(process.argv[2]),c.createPublicKey(pub),Buffer.from(fs.readFileSync(process.argv[3],"utf8").trim(),"base64"))?0:1)'
    & $Node $vjs $dl "$dl.sig"
    if ($LASTEXITCODE -eq 0) {
      if (Test-Path $exe) { $old = Join-Path $Root 'Rebond.old.exe'; Remove-Item -Force $old -ErrorAction SilentlyContinue; Move-Item -Force $exe $old }
      Copy-Item $dl $exe -Force; $okExe = $true; Say 'App native vérifiée (signature)'
    }
  } catch { }
  $ws = New-Object -ComObject WScript.Shell
  Remove-Item -Force $Old -ErrorAction SilentlyContinue
  if (-not $okExe) {
    # secours : ancien lanceur (fenêtre Edge)
    $launchers = Join-Path $Root "versions\$ver\lib\launchers.js"
    $vbs = (& $Node -e "process.stdout.write(require(process.argv[1]).win(process.argv[2],process.argv[3],process.argv[4]))" $launchers $Root $Node (Join-Path $env:APPDATA 'Sonde')) -join "`r`n"
    $vbsFile = Join-Path $Root 'Rebond.vbs'; Set-Content -Path $vbsFile -Value $vbs -Encoding Unicode
  }
  foreach ($lnk in @($StartMenu, $Desktop)) {
    $s = $ws.CreateShortcut($lnk)
    if ($okExe) { $s.TargetPath = $exe; $s.Arguments = ''; $s.IconLocation = "$exe,0" }
    else { $s.TargetPath = "$env:WINDIR\System32\wscript.exe"; $s.Arguments = "`"$vbsFile`""; $ico = Join-Path $Root "versions\$ver\assets\icon.ico"; if (Test-Path $ico) { $s.IconLocation = $ico } }
    $s.WorkingDirectory = $Root; $s.Description = 'Rebond : tests du réseau de la maison'; $s.Save()
  }
  Say "Rebond $ver est installé (menu Démarrer et bureau)."
  Say 'Les mises à jour suivantes s''installent toutes seules (Réglages → Mises à jour).'
  if (-not $NoLaunch) { if ($okExe) { Start-Process $exe } else { Start-Process "$env:WINDIR\System32\wscript.exe" "`"$vbsFile`"" } }
} finally { Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue }
