# Draws the plugin icon (Windows: System.Drawing). Original artwork, MIT like the rest of the repository.
# pwsh -NoProfile -File tools/icon/make-icon.ps1 -Out plugins/lz-gardening/assets/icon.png
param([string]$Out = 'icon.png')

Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

function Rgb([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

# Rounded square background.
$r = 230
$bg = [System.Drawing.Drawing2D.GraphicsPath]::new()
$bg.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
$bg.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
$bg.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
$bg.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
$bg.CloseFigure()
$bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Point]::new(0, 0), [System.Drawing.Point]::new(0, $size), (Rgb '#2F7A4D'), (Rgb '#1C4A31'))
$g.FillPath($bgBrush, $bg)

# Stem, drawn before the soil so it grows out of it.
$stemPen = [System.Drawing.Pen]::new((Rgb '#F3EEDC'), 46)
$stemPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($stemPen, 512, 820, 506, 700, 520, 580, 512, 478)

# Soil mound.
$soil = [System.Drawing.SolidBrush]::new((Rgb '#8A5A3B'))
$g.FillPie($soil, 212, 745, 600, 250, 180, 180)

function Leaf([float]$bx, [float]$by, [float]$tx, [float]$ty, [float]$bulge, [string]$fill, [string]$vein) {
  $dx = $tx - $bx; $dy = $ty - $by
  $len = [Math]::Sqrt($dx * $dx + $dy * $dy)
  $nx = -$dy / $len * $bulge; $ny = $dx / $len * $bulge
  $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $p.AddBezier($bx, $by, $bx + $dx * 0.3 + $nx, $by + $dy * 0.3 + $ny, $bx + $dx * 0.75 + $nx, $by + $dy * 0.75 + $ny, $tx, $ty)
  $p.AddBezier($tx, $ty, $bx + $dx * 0.75 - $nx, $by + $dy * 0.75 - $ny, $bx + $dx * 0.3 - $nx, $by + $dy * 0.3 - $ny, $bx, $by)
  $p.CloseFigure()
  $g.FillPath([System.Drawing.SolidBrush]::new((Rgb $fill)), $p)
  $veinPen = [System.Drawing.Pen]::new((Rgb $vein), 12)
  $veinPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($veinPen, $bx, $by, $bx + $dx * 0.82, $by + $dy * 0.82)
}

Leaf 512 600 236 430 105 '#A9DC7F' '#6FAF52'
Leaf 512 470 800 300 115 '#C7EC94' '#86C163'

$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
