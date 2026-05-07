# Simple HTTP server using built-in .NET — no Node.js or Python needed
$port   = 3000
$root   = Join-Path $PSScriptRoot "public"
$prefix = "http://localhost:$port/"

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host ""
Write-Host "  Smile Shutter dev server"
Write-Host "  http://localhost:$port"
Write-Host "  Ctrl+C to stop"
Write-Host ""

$mimeTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
}

try {
  while ($listener.IsListening) {
    $ctx  = $listener.GetContext()
    $req  = $ctx.Request
    $res  = $ctx.Response

    $path = $req.Url.LocalPath -replace '/', '\'
    if ($path -eq '\') { $path = '\index.html' }
    $file = Join-Path $root $path.TrimStart('\')

    if (Test-Path $file -PathType Leaf) {
      $ext  = [System.IO.Path]::GetExtension($file)
      $mime = if ($mimeTypes[$ext]) { $mimeTypes[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $res.ContentType   = $mime
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }

    $res.OutputStream.Close()
  }
} finally {
  $listener.Stop()
}
