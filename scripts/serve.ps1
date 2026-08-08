param(
    [int]$Port = 8123,
    [string]$Root = (Join-Path $PSScriptRoot "..")
)

$Root = (Resolve-Path $Root).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "Serving $Root at http://localhost:$Port/"

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        try {
            try {
                $path = $request.Url.AbsolutePath
                if ($path -eq "/") { $path = "/index.html" }
                $filePath = Join-Path $Root ($path.TrimStart("/"))
                $filePath = [System.IO.Path]::GetFullPath($filePath)
                if (-not $filePath.StartsWith($Root) -or -not (Test-Path $filePath -PathType Leaf)) {
                    $response.StatusCode = 404
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes("Not found")
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $ext = [System.IO.Path]::GetExtension($filePath)
                    $response.ContentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
                    $bytes = [System.IO.File]::ReadAllBytes($filePath)
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            } catch {
                # client disconnected mid-response or similar — drop this request, keep serving
            }
        } finally {
            try { $response.OutputStream.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
}
