param([int]$Left, [int]$Top, [int]$Width, [int]$Height, [string]$Output, [switch]$Capture)
# Own generated checkerboard only; screenshots are bounded to the tested app host.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MaterialFixtureDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, int flags);
}
'@
[MaterialFixtureDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Drawing
if ($Capture) {
  $bitmap = New-Object Drawing.Bitmap($Width, $Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($Left, $Top, 0, 0, $bitmap.Size)
    $bitmap.Save($Output, [Drawing.Imaging.ImageFormat]::Png)
    $samples = @(10, 30, ($Width - 30), ($Width - 10)) | ForEach-Object {
      $color = $bitmap.GetPixel($_, 10)
      @($color.R, $color.G, $color.B)
    }
    ConvertTo-Json -InputObject @($samples) -Compress
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
  exit
}
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object Windows.Forms.Form
$form.Text = 'Wisland material QA checkerboard'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.SetBounds($Left, $Top, $Width, $Height)
$form.ShowInTaskbar = $false
$form.Add_Paint({
  param($sender, $eventArgs)
  $a = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(190, 215, 235))
  $b = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(35, 70, 100))
  try {
    for ($y = 0; $y -lt $sender.Height; $y += 8) {
      for ($x = 0; $x -lt $sender.Width; $x += 8) {
        $brush = if ((($x / 8) + ($y / 8)) % 2 -eq 0) { $a } else { $b }
        $eventArgs.Graphics.FillRectangle($brush, $x, $y, 8, 8)
      }
    }
  } finally { $a.Dispose(); $b.Dispose() }
})
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  [MaterialFixtureDpi]::ShowWindow($form.Handle, 8) | Out-Null
  [MaterialFixtureDpi]::ShowWindow($form.Handle, 8) | Out-Null
  [MaterialFixtureDpi]::SetWindowPos($form.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x53) | Out-Null
  [MaterialFixtureDpi]::SetWindowPos($form.Handle, [IntPtr](-2), 0, 0, 0, 0, 0x53) | Out-Null
  $form.Refresh()
  if ($Output) { [IO.File]::WriteAllText($Output, 'ready') }
  $timer.Stop()
})
$timer.Start()
[Windows.Forms.Application]::Run($form)
