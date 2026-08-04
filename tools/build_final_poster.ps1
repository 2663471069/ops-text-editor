Add-Type -AssemblyName System.Drawing
$inputPath = Join-Path (Get-Location) 'data\codex-jobs\2f73bb59-a584-4380-8fcd-ec2b7a233a8d\input.png'
$outputPath = Join-Path (Get-Location) 'data\codex-jobs\2f73bb59-a584-4380-8fcd-ec2b7a233a8d\result.jpg'
$original = [System.Drawing.Bitmap]::FromFile($inputPath)
$cloneRect = New-Object System.Drawing.Rectangle(0, 0, $original.Width, $original.Height)
$final = $original.Clone($cloneRect, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)

for ($y = 28; $y -le 98; $y++) {
    $t = ($y - 28) / 70.0
    for ($x = 655; $x -le 966; $x++) {
        $top = $original.GetPixel($x, 22)
        $bottom = $original.GetPixel($x, 104)
        $r = [int][Math]::Round($top.R * (1 - $t) + $bottom.R * $t)
        $g = [int][Math]::Round($top.G * (1 - $t) + $bottom.G * $t)
        $b = [int][Math]::Round($top.B * (1 - $t) + $bottom.B * $t)
        $final.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($r, $g, $b))
    }
}

$graphics = [System.Drawing.Graphics]::FromImage($final)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$family = New-Object System.Drawing.FontFamily('Arial')
$format = [System.Drawing.StringFormat]::GenericTypographic
$size = 65.0
do {
    if ($path) { $path.Dispose() }
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $origin = New-Object System.Drawing.PointF(0, 0)
    $path.AddString('ABCDEFG', $family, [int][System.Drawing.FontStyle]::Regular, $size, $origin, $format)
    $bounds = $path.GetBounds()
    if ($bounds.Width -gt 300 -or $bounds.Height -gt 62) { $size -= 1.0 }
} while (($bounds.Width -gt 300 -or $bounds.Height -gt 62) -and $size -gt 36)

$matrix = New-Object System.Drawing.Drawing2D.Matrix
$targetCenterX = 810.5
$targetCenterY = 63.0
$matrix.Translate([single]($targetCenterX - ($bounds.X + $bounds.Width / 2)), [single]($targetCenterY - ($bounds.Y + $bounds.Height / 2)))
$path.Transform($matrix)
$outline = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 228, 216), 2.5)
$outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(91, 10, 10))
$graphics.DrawPath($outline, $path)
$graphics.FillPath($fill, $path)

$jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 96L)
$final.Save($outputPath, $jpgCodec, $encoderParams)

$encoderParams.Dispose(); $fill.Dispose(); $outline.Dispose(); $matrix.Dispose(); $path.Dispose(); $family.Dispose(); $graphics.Dispose(); $final.Dispose(); $original.Dispose()
