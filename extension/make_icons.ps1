Add-Type -AssemblyName System.Drawing

$sizes = @(16, 48, 128)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # Dark background
    $bgColor = [System.Drawing.Color]::FromArgb(255, 16, 16, 28)
    $g.Clear($bgColor)

    # Indigo circle
    $circleColor = [System.Drawing.Color]::FromArgb(255, 99, 102, 241)
    $brush = New-Object System.Drawing.SolidBrush($circleColor)
    $margin = [int]($size * 0.08)
    $g.FillEllipse($brush, $margin, $margin, $size - ($margin * 2), $size - ($margin * 2))

    # White dot in center
    $dotColor = [System.Drawing.Color]::White
    $dotBrush = New-Object System.Drawing.SolidBrush($dotColor)
    $dotSize = [int]($size * 0.25)
    $dotOffset = [int](($size - $dotSize) / 2)
    $g.FillEllipse($dotBrush, $dotOffset, $dotOffset, $dotSize, $dotSize)

    $g.Dispose()
    $outPath = "c:\Users\POOJAN\OneDrive\Documents\CareerOS\extension\icons\icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Created $outPath"
}

Write-Host "Done."
