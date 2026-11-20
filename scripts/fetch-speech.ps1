# Fetch the exact speech engine and Whisper Tiny model used by KothaNote.
#
# The AAR and model are large binary files, so they are not committed to git.
# Run this once before the first Windows build:
#
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-speech.ps1
#
# Every download is SHA-256 verified. Existing files with the right hash are
# left untouched, so repeated runs are cheap.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$AarUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-2.0.2.aar"
$AarSha256 = "6420cfb86c2ef8462dadd77b2202b7430487bdfb2bc715e9ce2864871209a80e"

$ModelUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2"
$ModelSha256 = "c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1"

$EncoderSha256 = "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434"
$DecoderSha256 = "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925"
$TokensSha256 = "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126"

$Aar = Join-Path $Root "app\libs\sherpa-onnx-2.0.2.aar"
$ModelDir = Join-Path $Root "app\src\main\assets\asr"
$ModelMembers = @(
    "sherpa-onnx-whisper-tiny/tiny-encoder.int8.onnx",
    "sherpa-onnx-whisper-tiny/tiny-decoder.int8.onnx",
    "sherpa-onnx-whisper-tiny/tiny-tokens.txt"
)

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Test-FileHash([string]$Path, [string]$Expected, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-Host "$Label is missing: $Path" -ForegroundColor Yellow
        return $false
    }
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected) {
        Write-Host "$Label has the wrong SHA-256." -ForegroundColor Yellow
        Write-Host "  file:     $Path"
        Write-Host "  expected: $Expected"
        Write-Host "  actual:   $actual"
        return $false
    }
    return $true
}

function Assert-FileHash([string]$Path, [string]$Expected, [string]$Label) {
    if (-not (Test-FileHash $Path $Expected $Label)) {
        throw "$Label failed SHA-256 verification."
    }
}

function Get-RemoteFile([string]$Url, [string]$Destination) {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Test-Aar {
    return Test-FileHash $Aar $AarSha256 "sherpa-onnx AAR"
}

function Test-Model {
    return (Test-FileHash (Join-Path $ModelDir "tiny-encoder.int8.onnx") $EncoderSha256 "Whisper encoder") -and
        (Test-FileHash (Join-Path $ModelDir "tiny-decoder.int8.onnx") $DecoderSha256 "Whisper decoder") -and
        (Test-FileHash (Join-Path $ModelDir "tiny-tokens.txt") $TokensSha256 "Whisper tokens")
}

if ((Test-Aar) -and (Test-Model)) {
    Write-Host "Speech engine and Whisper Tiny model are already present and verified." -ForegroundColor Green
    exit 0
}

$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("kotha-speech-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Temp | Out-Null

try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Aar) | Out-Null
    New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null

    if (-not (Test-Aar)) {
        $tempAar = Join-Path $Temp "sherpa-onnx-2.0.2.aar"
        Get-RemoteFile $AarUrl $tempAar
        Assert-FileHash $tempAar $AarSha256 "sherpa-onnx AAR"
        Copy-Item -LiteralPath $tempAar -Destination $Aar -Force
        Assert-FileHash $Aar $AarSha256 "sherpa-onnx AAR"
        Write-Host "Installed $Aar"
    }

    if (-not (Test-Model)) {
        $archive = Join-Path $Temp "sherpa-onnx-whisper-tiny.tar.bz2"
        Get-RemoteFile $ModelUrl $archive
        Assert-FileHash $archive $ModelSha256 "Whisper Tiny archive"

        & tar -xjf $archive -C $Temp $ModelMembers
        if ($LASTEXITCODE -ne 0) {
            throw "Could not extract the Whisper Tiny archive (tar exit code $LASTEXITCODE)."
        }

        foreach ($name in @("tiny-encoder.int8.onnx", "tiny-decoder.int8.onnx", "tiny-tokens.txt")) {
            Copy-Item -LiteralPath (Join-Path $Temp "sherpa-onnx-whisper-tiny\$name") -Destination (Join-Path $ModelDir $name) -Force
        }

        Assert-FileHash (Join-Path $ModelDir "tiny-encoder.int8.onnx") $EncoderSha256 "Whisper encoder"
        Assert-FileHash (Join-Path $ModelDir "tiny-decoder.int8.onnx") $DecoderSha256 "Whisper decoder"
        Assert-FileHash (Join-Path $ModelDir "tiny-tokens.txt") $TokensSha256 "Whisper tokens"
        Write-Host "Installed the Whisper Tiny int8 model in $ModelDir"
    }

    Write-Host "Speech assets are ready." -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
