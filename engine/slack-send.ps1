# Slack transport: chat.postMessage, or image upload into the thread when the payload has files (Windows PowerShell 5.1+). Invoked by engine/notify.mjs as a child process.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts with the ANSI code page.
# - Payload is read from a file only (no command-line string interpolation).
# - The token file must be encrypted for the current Windows user (DPAPI or ConvertFrom-SecureString output).
#   Plain-text tokens are rejected. The token is never printed.
# - Stdout is a single JSON result line. Exception messages are never printed, only type names.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PayloadFile,
  [Parameter(Mandatory = $true)][string]$TokenFile,
  [Parameter(Mandatory = $true)][string]$Channel
)
$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$Result) {
  [Console]::Out.WriteLine(($Result | ConvertTo-Json -Compress))
}

function Get-CredentialText([byte[]]$Bytes) {
  if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) {
    return [Text.Encoding]::Unicode.GetString($Bytes, 2, $Bytes.Length - 2)
  }
  if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
    return [Text.Encoding]::UTF8.GetString($Bytes, 3, $Bytes.Length - 3)
  }
  return [Text.Encoding]::ASCII.GetString($Bytes)
}

function Unprotect-Token([string]$Path) {
  Add-Type -AssemblyName System.Security
  $raw = [IO.File]::ReadAllBytes($Path)
  $text = (Get-CredentialText $raw).Trim()
  if ($text -match '^xox') { return $null }
  if ($text -match '^[0-9a-fA-F]+$') {
    # ConvertFrom-SecureString output. Load the module from this host's own PSHOME so a PowerShell 7 parent
    # does not leak an incompatible Microsoft.PowerShell.Security through PSModulePath.
    $securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    Import-Module -Name $securityModule -Force
    $secure = ConvertTo-SecureString -String $text
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  $protected = $raw
  if ($text -match '^[A-Za-z0-9+/=\s]+$') { $protected = [Convert]::FromBase64String(($text -replace '\s', '')) }
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try { return ([Text.Encoding]::UTF8.GetString($plain)).Trim() }
  finally { [Array]::Clear($plain, 0, $plain.Length) }
}

try {
  $payload = Get-Content -LiteralPath $PayloadFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Write-Result @{ ok = $false; configError = 'READ_PAYLOAD' }; exit 2
}
if ([string]$payload.channel -ne $Channel) { Write-Result @{ ok = $false; configError = 'DESTINATION_MISMATCH' }; exit 2 }
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) { Write-Result @{ ok = $false; configError = 'TOKEN_FILE_MISSING' }; exit 2 }

$token = $null
try { $token = Unprotect-Token $TokenFile } catch { $token = $null }
if (-not $token -or $token -notmatch '^xox[bp]-') {
  $token = $null
  Write-Result @{ ok = $false; configError = 'TOKEN_UNREADABLE' }; exit 2
}

Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(60)

function New-ApiRequest([string]$Method, $Content) {
  $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "https://slack.com/api/$Method")
  $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
  $request.Content = $Content
  return $request
}

function New-FormContent([hashtable]$Fields) {
  $pairs = New-Object 'System.Collections.Generic.Dictionary[string,string]'
  foreach ($key in $Fields.Keys) { $pairs.Add($key, [string]$Fields[$key]) }
  return New-Object System.Net.Http.FormUrlEncodedContent($pairs)
}

# Sends one request. Returns @{ data = <parsed JSON or $null when -Raw> } or @{ fail = <result>; code = <exit code> }.
function Send-Request($Request, [switch]$Raw) {
  try {
    $response = $client.SendAsync($Request).GetAwaiter().GetResult()
  } catch {
    $inner = $_.Exception.InnerException
    while ($inner -and -not ($inner -is [Net.WebException]) -and $inner.InnerException) { $inner = $inner.InnerException }
    if ($inner -is [Net.WebException] -and ($inner.Status -eq [Net.WebExceptionStatus]::NameResolutionFailure -or $inner.Status -eq [Net.WebExceptionStatus]::ConnectFailure)) {
      return @{ fail = @{ ok = $false; uncertain = $false; errorType = 'CONNECT_FAILED' }; code = 5 }
    }
    return @{ fail = @{ ok = $false; uncertain = $true; errorType = $_.Exception.GetType().Name }; code = 3 }
  } finally {
    $Request.Dispose()
  }
  $status = [int]$response.StatusCode
  if ($status -eq 429) {
    $retryAfter = 30
    $ra = $response.Headers.RetryAfter
    if ($ra -and $null -ne $ra.Delta) {
      $retryAfter = [int][Math]::Ceiling($ra.Delta.TotalSeconds)
    } elseif ($ra -and $null -ne $ra.Date) {
      $retryAfter = [int][Math]::Max(0, [Math]::Ceiling(($ra.Date - [DateTimeOffset]::UtcNow).TotalSeconds))
    }
    return @{ fail = @{ ok = $false; httpStatus = 429; retryAfter = $retryAfter }; code = 4 }
  }
  if ($Raw) {
    if ($status -eq 200) { return @{ data = $null } }
    return @{ fail = @{ ok = $false; httpStatus = $status; errorType = 'UPLOAD_HTTP' }; code = 5 }
  }
  try {
    $data = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
  } catch {
    return @{ fail = @{ ok = $false; uncertain = $true; httpStatus = $status; errorType = 'RESPONSE_UNREADABLE' }; code = 3 }
  }
  if ($status -eq 200 -and $data.ok -eq $true) { return @{ data = $data } }
  return @{ fail = @{ ok = $false; httpStatus = $status; slackError = [string]$data.error }; code = 5 }
}

function Exit-With($Outcome) {
  $script:token = $null
  Write-Result $Outcome.fail
  exit $Outcome.code
}

# Images: files.getUploadURLExternal -> POST bytes -> files.completeUploadExternal (into the thread).
if ($payload.files) {
  $uploaded = @()
  foreach ($file in @($payload.files)) {
    $filePath = [string]$file.path
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { $token = $null; Write-Result @{ ok = $false; configError = 'FILE_MISSING' }; exit 2 }
    try {
      $bytes = [IO.File]::ReadAllBytes($filePath)
      $request = New-ApiRequest 'files.getUploadURLExternal' (New-FormContent @{ filename = [IO.Path]::GetFileName($filePath); length = $bytes.Length })
    } catch {
      $token = $null; Write-Result @{ ok = $false; errorType = 'REQUEST_BUILD_FAILED' }; exit 5
    }
    $r = Send-Request $request
    if ($r.fail) { Exit-With $r }
    $upload = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, [string]$r.data.upload_url)
    $upload.Content = New-Object System.Net.Http.ByteArrayContent(, $bytes)
    $u = Send-Request $upload -Raw
    if ($u.fail) { Exit-With $u }
    $uploaded += @{ id = [string]$r.data.file_id; title = [string]$file.title }
  }
  $fields = @{ files = (ConvertTo-Json -InputObject @($uploaded) -Compress); channel_id = $Channel }
  if ($payload.threadTs) { $fields.thread_ts = [string]$payload.threadTs }
  $c = Send-Request (New-ApiRequest 'files.completeUploadExternal' (New-FormContent $fields))
  $token = $null
  if ($c.fail) { Write-Result $c.fail; exit $c.code }
  Write-Result @{ ok = $true; files = $uploaded.Count }; exit 0
}

try {
  $body = @{ channel = $Channel; text = [string]$payload.text; unfurl_links = $false; unfurl_media = $false }
  if ($payload.threadTs) { $body.thread_ts = [string]$payload.threadTs }
  $json = $body | ConvertTo-Json -Compress
  $request = New-ApiRequest 'chat.postMessage' (New-Object System.Net.Http.StringContent($json, [Text.Encoding]::UTF8, 'application/json'))
} catch {
  $token = $null
  Write-Result @{ ok = $false; errorType = 'REQUEST_BUILD_FAILED' }; exit 5
}
$r = Send-Request $request
$token = $null
if ($r.fail) { Write-Result $r.fail; exit $r.code }
Write-Result @{ ok = $true; ts = [string]$r.data.ts }; exit 0
