param(
    [string]$WorkDir = (Join-Path $PSScriptRoot "..\.interop"),
    [int]$MaxDifferentPixels = 1000
)

$ErrorActionPreference = "Stop"
if ($MaxDifferentPixels -lt 0) { throw "MaxDifferentPixels must be non-negative" }
$WorkDir = [System.IO.Path]::GetFullPath($WorkDir)

Push-Location (Join-Path $PSScriptRoot "..")
try {
    & npm run interop:validate -- $WorkDir
    if ($LASTEXITCODE -ne 0) { throw "Manifest or input validation failed" }
} finally {
    Pop-Location
}

$ManifestPath = Join-Path $WorkDir "manifest.json"
$Manifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json
if ($Manifest.schemaVersion -ne 1) { throw "Invalid interoperability manifest" }

if (-not (Get-Command pdftoppm -ErrorAction SilentlyContinue)) { throw "pdftoppm is required" }
if (-not (Get-Command magick -ErrorAction SilentlyContinue)) { throw "ImageMagick magick is required" }

$ProviderVisualDir = Join-Path $WorkDir "visual\word"
$ReopenedDir = Join-Path $WorkDir "reopened\word"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $ReopenedDir, $ProviderVisualDir
$BaselinePdfDir = Join-Path $ProviderVisualDir "baseline-pdf"
$ReopenedPdfDir = Join-Path $ProviderVisualDir "reopened-pdf"
$BaselinePngDir = Join-Path $ProviderVisualDir "baseline-png"
$ReopenedPngDir = Join-Path $ProviderVisualDir "reopened-png"
@($ReopenedDir, $BaselinePdfDir, $ReopenedPdfDir, $BaselinePngDir, $ReopenedPngDir) | ForEach-Object {
    New-Item -ItemType Directory -Force -Path $_ | Out-Null
}

$Word = $null

function Assert-MicrosoftOfficeApplication($Application, [string]$ExecutableName, [string]$ProductName) {
    $ExecutablePath = Join-Path $Application.Path $ExecutableName
    if (-not (Test-Path $ExecutablePath -PathType Leaf)) {
        throw "$ProductName COM registration does not resolve to $ExecutableName; Microsoft Office is required"
    }
    $CompanyName = (Get-Item $ExecutablePath).VersionInfo.CompanyName
    if ($CompanyName -ne "Microsoft Corporation") {
        throw "$ProductName executable is not published by Microsoft Corporation: $ExecutablePath"
    }
}

function Export-Pdf([string]$DocxPath, [string]$PdfPath) {
    $Document = $null
    try {
        $Document = $Word.Documents.Open($DocxPath, $false, $true, $false, "", "", $false, "", "", 0, $false, $false, 0, $true, 0, $false)
        $Document.ExportAsFixedFormat($PdfPath, 17)
    } finally {
        if ($null -ne $Document) {
            try { $Document.Close(0) } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Document) }
        }
    }
    if (-not (Test-Path $PdfPath) -or (Get-Item $PdfPath).Length -eq 0) { throw "Word produced an empty PDF: $PdfPath" }
}

try {
    $Word = New-Object -ComObject Word.Application
    Assert-MicrosoftOfficeApplication $Word "WINWORD.EXE" "Word"
    $Word.Visible = $false
    $Word.DisplayAlerts = 0
    foreach ($Case in $Manifest.cases) {
        $InputPath = Join-Path $WorkDir "inputs\$($Case.id).docx"
        $ReopenedPath = Join-Path $ReopenedDir "$($Case.id).docx"
        $Document = $null
        try {
            $Document = $Word.Documents.Open($InputPath, $false, $true, $false, "", "", $false, "", "", 0, $false, $false, 0, $true, 0, $false)
            $Document.SaveAs2($ReopenedPath, 12)
        } finally {
            if ($null -ne $Document) {
                try { $Document.Close(0) } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Document) }
            }
        }
        if (-not (Test-Path $ReopenedPath) -or (Get-Item $ReopenedPath).Length -eq 0) { throw "Word did not save $($Case.id)" }

        $BaselinePdf = Join-Path $BaselinePdfDir "$($Case.id).pdf"
        $ReopenedPdf = Join-Path $ReopenedPdfDir "$($Case.id).pdf"
        Export-Pdf $InputPath $BaselinePdf
        Export-Pdf $ReopenedPath $ReopenedPdf

        $BaselinePrefix = Join-Path $BaselinePngDir $Case.id
        $ReopenedPrefix = Join-Path $ReopenedPngDir $Case.id
        & pdftoppm -png -r 144 $BaselinePdf $BaselinePrefix
        if ($LASTEXITCODE -ne 0) { throw "pdftoppm failed for baseline $($Case.id)" }
        & pdftoppm -png -r 144 $ReopenedPdf $ReopenedPrefix
        if ($LASTEXITCODE -ne 0) { throw "pdftoppm failed for reopened $($Case.id)" }

        $BaselinePages = @(Get-ChildItem $BaselinePngDir -Filter "$($Case.id)-*.png" | Sort-Object Name)
        $ReopenedPages = @(Get-ChildItem $ReopenedPngDir -Filter "$($Case.id)-*.png" | Sort-Object Name)
        if ($BaselinePages.Count -eq 0 -or $BaselinePages.Count -ne $ReopenedPages.Count) {
            throw "$($Case.id): visual page count changed after Word reopen"
        }
        for ($Index = 0; $Index -lt $BaselinePages.Count; $Index += 1) {
            $MetricOutput = & magick compare -metric AE -fuzz 1% $BaselinePages[$Index].FullName $ReopenedPages[$Index].FullName "null:" 2>&1
            $CompareExit = $LASTEXITCODE
            if ($CompareExit -gt 1) { throw "ImageMagick compare failed for $($Case.id)" }
            $MetricText = ($MetricOutput | Select-Object -Last 1).ToString().Trim()
            $Metric = 0.0
            if (-not [double]::TryParse($MetricText, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$Metric)) {
                throw "Invalid ImageMagick metric for $($Case.id): $MetricText"
            }
            if ($Metric -gt $MaxDifferentPixels) {
                throw "$($Case.id): $Metric pixels changed after Word reopen (limit $MaxDifferentPixels)"
            }
        }
    }
} finally {
    if ($null -ne $Word) {
        try { $Word.Quit() } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Word) }
    }
}

Push-Location (Join-Path $PSScriptRoot "..")
try {
    & npm run interop:verify -- $WorkDir word
    if ($LASTEXITCODE -ne 0) { throw "Semantic verification failed" }
} finally {
    Pop-Location
}

Write-Host "Microsoft Word interoperability and visual checks passed in $WorkDir"
