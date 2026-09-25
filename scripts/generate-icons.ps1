param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\public\icons')
)

Add-Type -AssemblyName System.Drawing

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

function New-RoundedRectanglePath {
  param(
    [single]$X,
    [single]$Y,
    [single]$Width,
    [single]$Height,
    [single]$Radius
  )

  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

foreach ($size in 16, 32, 48, 128) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $inset = [single]($size * 0.04)
  $backgroundPath = New-RoundedRectanglePath `
    -X $inset `
    -Y $inset `
    -Width ([single]($size - 2 * $inset)) `
    -Height ([single]($size - 2 * $inset)) `
    -Radius ([single]($size * 0.22))
  $backgroundBrush = [System.Drawing.SolidBrush]::new(
    [System.Drawing.Color]::FromArgb(255, 29, 78, 216)
  )
  $graphics.FillPath($backgroundBrush, $backgroundPath)

  $shield = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $shieldPoints = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new([single]($size * 0.50), [single]($size * 0.17)),
    [System.Drawing.PointF]::new([single]($size * 0.76), [single]($size * 0.28)),
    [System.Drawing.PointF]::new([single]($size * 0.71), [single]($size * 0.65)),
    [System.Drawing.PointF]::new([single]($size * 0.50), [single]($size * 0.83)),
    [System.Drawing.PointF]::new([single]($size * 0.29), [single]($size * 0.65)),
    [System.Drawing.PointF]::new([single]($size * 0.24), [single]($size * 0.28))
  )
  $shield.AddPolygon($shieldPoints)
  $shieldBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $graphics.FillPath($shieldBrush, $shield)

  $checkPen = [System.Drawing.Pen]::new(
    [System.Drawing.Color]::FromArgb(255, 5, 150, 105),
    [single][Math]::Max(1.7, $size * 0.075)
  )
  $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawLines($checkPen, [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new([single]($size * 0.36), [single]($size * 0.50)),
    [System.Drawing.PointF]::new([single]($size * 0.46), [single]($size * 0.61)),
    [System.Drawing.PointF]::new([single]($size * 0.65), [single]($size * 0.39))
  ))

  $path = Join-Path $resolvedOutput "icon-$size.png"
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  $checkPen.Dispose()
  $shieldBrush.Dispose()
  $shield.Dispose()
  $backgroundBrush.Dispose()
  $backgroundPath.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
