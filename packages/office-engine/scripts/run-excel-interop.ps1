param(
    [string]$WorkDir = (Join-Path $PSScriptRoot "..\.xlsx-interop"),
    [int]$MaxDifferentPixels = 1000
)
$ErrorActionPreference = "Stop"
if ($MaxDifferentPixels -lt 0) { throw "MaxDifferentPixels must be non-negative" }
$WorkDir = [System.IO.Path]::GetFullPath($WorkDir)
Push-Location (Join-Path $PSScriptRoot "..")
try {
    & npm run xlsx-interop:validate -- $WorkDir
    if ($LASTEXITCODE -ne 0) { throw "XLSX manifest or input validation failed" }
} finally { Pop-Location }
$Manifest = Get-Content -Raw (Join-Path $WorkDir "manifest.json") | ConvertFrom-Json
if ($Manifest.schemaVersion -ne 1 -or $null -eq $Manifest.case) { throw "Invalid XLSX interoperability manifest" }
if (-not (Get-Command pdftoppm -ErrorAction SilentlyContinue)) { throw "pdftoppm is required" }
if (-not (Get-Command magick -ErrorAction SilentlyContinue)) { throw "ImageMagick magick is required" }
$Case = $Manifest.case
$ProviderVisualDir = Join-Path $WorkDir "visual\excel"
$ReopenedDir = Join-Path $WorkDir "reopened\excel"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $ReopenedDir, $ProviderVisualDir
$BaselinePdfDir = Join-Path $ProviderVisualDir "baseline-pdf"
$ReopenedPdfDir = Join-Path $ProviderVisualDir "reopened-pdf"
$BaselinePngDir = Join-Path $ProviderVisualDir "baseline-png"
$ReopenedPngDir = Join-Path $ProviderVisualDir "reopened-png"
@($ReopenedDir, $BaselinePdfDir, $ReopenedPdfDir, $BaselinePngDir, $ReopenedPngDir) | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
$Excel = $null
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
function Open-Workbook([string]$WorkbookPath, [bool]$ReadOnly) {
    $Missing = [Type]::Missing
    return $Excel.Workbooks.Open(
        $WorkbookPath,
        0,
        $ReadOnly,
        $Missing,
        $Missing,
        $Missing,
        $true,
        $Missing,
        $Missing,
        $false,
        $false,
        $Missing,
        $false,
        $true,
        0
    )
}
function Export-Pdf([string]$WorkbookPath, [string]$PdfPath) {
    $Workbook = $null
    try {
        $Workbook = Open-Workbook $WorkbookPath $true
        $Workbook.ExportAsFixedFormat(0, $PdfPath)
    } finally {
        if ($null -ne $Workbook) { try { $Workbook.Close($false) } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Workbook) } }
    }
    if (-not (Test-Path $PdfPath) -or (Get-Item $PdfPath).Length -eq 0) { throw "Excel produced an empty PDF: $PdfPath" }
}
try {
    $Excel = New-Object -ComObject Excel.Application
    Assert-MicrosoftOfficeApplication $Excel "EXCEL.EXE" "Excel"
    $Excel.Visible = $false
    $Excel.DisplayAlerts = $false
    $InputPath = Join-Path $WorkDir $Case.input
    $ReopenedPath = Join-Path $ReopenedDir ([System.IO.Path]::GetFileName($Case.input))
    $Workbook = $null
    try {
        $Workbook = Open-Workbook $InputPath $false
        $Workbook.SaveAs($ReopenedPath, 51)
    } finally {
        if ($null -ne $Workbook) { try { $Workbook.Close($false) } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Workbook) } }
    }
    if (-not (Test-Path $ReopenedPath) -or (Get-Item $ReopenedPath).Length -eq 0) { throw "Excel did not save $($Case.id)" }
    $BaselinePdf = Join-Path $BaselinePdfDir "$($Case.id).pdf"
    $ReopenedPdf = Join-Path $ReopenedPdfDir "$($Case.id).pdf"
    Export-Pdf $InputPath $BaselinePdf
    Export-Pdf $ReopenedPath $ReopenedPdf
    $BaselinePrefix = Join-Path $BaselinePngDir $Case.id
    $ReopenedPrefix = Join-Path $ReopenedPngDir $Case.id
    & pdftoppm -png -r 144 $BaselinePdf $BaselinePrefix
    if ($LASTEXITCODE -ne 0) { throw "pdftoppm failed for XLSX baseline" }
    & pdftoppm -png -r 144 $ReopenedPdf $ReopenedPrefix
    if ($LASTEXITCODE -ne 0) { throw "pdftoppm failed for XLSX reopened output" }
    $BaselinePages = @(Get-ChildItem $BaselinePngDir -Filter "$($Case.id)-*.png" | Sort-Object Name)
    $ReopenedPages = @(Get-ChildItem $ReopenedPngDir -Filter "$($Case.id)-*.png" | Sort-Object Name)
    if ($BaselinePages.Count -eq 0 -or $BaselinePages.Count -ne $ReopenedPages.Count) { throw "XLSX visual page count changed after Excel reopen" }
    for ($Index = 0; $Index -lt $BaselinePages.Count; $Index += 1) {
        $MetricOutput = & magick compare -metric AE -fuzz 1% $BaselinePages[$Index].FullName $ReopenedPages[$Index].FullName "null:" 2>&1
        if ($LASTEXITCODE -gt 1) { throw "ImageMagick compare failed for XLSX" }
        $Metric = 0.0
        $MetricText = ($MetricOutput | Select-Object -Last 1).ToString().Trim()
        if (-not [double]::TryParse($MetricText, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$Metric)) { throw "Invalid ImageMagick metric: $MetricText" }
        if ($Metric -gt $MaxDifferentPixels) { throw "$Metric pixels changed after Excel reopen (limit $MaxDifferentPixels)" }
    }
} finally {
    if ($null -ne $Excel) { try { $Excel.Quit() } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Excel) } }
}
Push-Location (Join-Path $PSScriptRoot "..")
try {
    & npm run xlsx-interop:verify -- $WorkDir excel
    if ($LASTEXITCODE -ne 0) { throw "XLSX semantic verification failed" }
} finally { Pop-Location }
Write-Host "Microsoft Excel interoperability and visual checks passed in $WorkDir"
