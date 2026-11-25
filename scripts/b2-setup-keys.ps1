<#
  Backup keys setup (owner task O-05, part B of docs/runbooks/backup-setup.md).

  Run from the repository folder, in PowerShell, AFTER the backup Worker has
  been deployed to staging and you are logged in to wrangler and gh:

      powershell -ExecutionPolicy Bypass -File scripts\b2-setup-keys.ps1

  It asks for a temporary Backblaze MASTER application key (hidden prompts),
  checks both staging buckets (Object Lock and encryption on), then creates:

    1. the backup JOB key: both buckets; list, read, write, set and read
       retentions. NO deleteFiles, NO bypassGovernance (BAK-05). Stored
       directly as secrets of the cg-backup-staging Worker (never shown).
    2. the VERIFY key: both buckets; read-only. Stored directly as GitHub
       `staging` environment secrets for the weekly backup:verify (never shown).
    3. the BREAK-GLASS key: can delete and override locks. Shown ONCE for you
       to write down and keep offline. Only for docs/runbooks/emergency-purge.md.

  It also asks for the alert email address and stores it as a Worker secret.
  Nothing is written to disk or to this repository.
#>
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'oddacious-collection/collection-gallery'
$Buckets = @('oddacioustreasures-com-staging-db-backups', 'oddacioustreasures-com-staging-media-backups')
$WorkerConfig = 'apps\backup\wrangler.jsonc'

function Read-Secret([string]$Prompt) {
  $sec = Read-Host -Prompt $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-B2([string]$Url, [string]$Token, [hashtable]$Body) {
  Invoke-RestMethod -Method Post -Uri $Url -Headers @{ Authorization = $Token } `
    -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress -Depth 5)
}

function Set-WorkerSecret([string]$Name, [string]$Value) {
  $Value | npx.cmd wrangler secret put $Name --config $WorkerConfig --env staging | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "wrangler could not set $Name" }
}

function Set-GitHubSecret([string]$Name, [string]$Value) {
  $Value | gh secret set $Name --env staging --repo $Repo | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "gh could not set $Name" }
}

if (-not (Test-Path $WorkerConfig)) { throw 'Run this from the repository folder (C:\dev\collection-gallery).' }

Write-Host ''
Write-Host 'Backblaze: Application Keys -> Generate New Master Application Key, then paste below.' -ForegroundColor Cyan
$masterId = (Read-Host -Prompt 'Master keyID').Trim()
$masterKey = (Read-Secret 'Master applicationKey (hidden)').Trim()

$auth = Invoke-RestMethod -Uri 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account' `
  -Headers @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${masterId}:${masterKey}")) }
$api = $auth.apiInfo.storageApi.apiUrl
$token = $auth.authorizationToken
$accountId = $auth.accountId
$masterKey = $null

# Check both buckets exist with Object Lock and default encryption on.
$bucketIds = @()
foreach ($name in $Buckets) {
  $res = Invoke-B2 "$api/b2api/v3/b2_list_buckets" $token @{ accountId = $accountId; bucketName = $name }
  $b = $res.buckets | Where-Object { $_.bucketName -eq $name }
  if (-not $b) { throw "Bucket $name not found. Create it first (part A2), or tell Claude the name you used." }
  if (-not $b.fileLockConfiguration.value.isFileLockEnabled) { throw "Object Lock is not enabled on $name (part A2)." }
  if ($b.defaultServerSideEncryption.value.mode -ne 'SSE-B2') { throw "Default encryption is not enabled on $name (part A2)." }
  if ($b.bucketType -ne 'allPrivate') { throw "$name must be Private (part A2)." }
  $bucketIds += $b.bucketId
  Write-Host "ok  bucket $name (private, encrypted, Object Lock on)"
}

# Lifecycle rules (part A3), set here so the numbers are exact. These only
# tidy up old copies; Object Lock still protects every file until its date.
$lifecycle = @{
  'oddacioustreasures-com-staging-db-backups'    = @(
    @{ fileNamePrefix = 'daily/'; daysFromUploadingToHiding = 31; daysFromHidingToDeleting = 1 },
    @{ fileNamePrefix = 'monthly/'; daysFromUploadingToHiding = 366; daysFromHidingToDeleting = 1 }
  )
  'oddacioustreasures-com-staging-media-backups' = @(
    @{ fileNamePrefix = ''; daysFromUploadingToHiding = $null; daysFromHidingToDeleting = 365 }
  )
}
for ($i = 0; $i -lt $Buckets.Count; $i++) {
  Invoke-B2 "$api/b2api/v3/b2_update_bucket" $token @{
    accountId = $accountId; bucketId = $bucketIds[$i]; lifecycleRules = $lifecycle[$Buckets[$i]]
  } | Out-Null
  Write-Host "ok  lifecycle rules set on $($Buckets[$i])"
}

function New-Key([string]$KeyName, [string[]]$Capabilities) {
  Invoke-B2 "$api/b2api/v3/b2_create_key" $token @{
    accountId = $accountId; keyName = $KeyName; capabilities = $Capabilities; bucketIds = $bucketIds
  }
}

# 1. Backup job key: can add files and set locks; can't delete or bypass locks.
$job = New-Key 'cg-backup-staging-job' @('listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'writeFileRetentions', 'readFileRetentions')
Set-WorkerSecret 'B2_KEY_ID' $job.applicationKeyId
Set-WorkerSecret 'B2_APP_KEY' $job.applicationKey
$job = $null
Write-Host 'ok  backup job key created and stored in the cg-backup-staging Worker'

# 2. Verify key: read-only, for the weekly GitHub check.
$verify = New-Key 'cg-backup-staging-verify' @('listBuckets', 'listFiles', 'readFiles', 'readFileRetentions')
Set-GitHubSecret 'B2_VERIFY_KEY_ID' $verify.applicationKeyId
Set-GitHubSecret 'B2_VERIFY_APP_KEY' $verify.applicationKey
$verify = $null
Write-Host 'ok  verify key created and stored as GitHub staging secrets'

# 3. Alert address (never committed).
$to = (Read-Host -Prompt 'Email address for backup failure alerts').Trim()
if ($to -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'That does not look like an email address.' }
Set-WorkerSecret 'ALERT_TO' $to
Write-Host 'ok  alert address stored in the cg-backup-staging Worker'

# 4. Break-glass key: shown once.
$glass = New-Key 'cg-backup-staging-breakglass' @('listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'deleteFiles', 'bypassGovernance', 'readFileRetentions', 'writeFileRetentions')
Write-Host ''
Write-Host '================ BREAK-GLASS KEY (shown once) ================' -ForegroundColor Yellow
Write-Host "keyID:          $($glass.applicationKeyId)"
Write-Host "applicationKey: $($glass.applicationKey)"
Write-Host '===============================================================' -ForegroundColor Yellow
Write-Host 'Write both down and keep them offline with your Backblaze backup codes.'
Write-Host 'They are needed only for docs/runbooks/emergency-purge.md.'
$glass = $null
Read-Host -Prompt 'Press Enter once you have written them down (the window will clear)' | Out-Null
Clear-Host

Write-Host 'Done. Last step: in Backblaze, click "Generate New Master Application Key"'
Write-Host 'once more and do NOT save it. That cancels the master key you just used.'
Write-Host 'Then tell Claude: "backup keys are set up".'
