# Emergency purge from the backups (BAK-05)

Backups are locked (Object Lock, governance mode) so that nobody with the
normal keys can delete them. Use this runbook only when something must be
removed from the backups **now**, for example a photo uploaded by mistake
that shows something private. Otherwise let the lifecycle rules expire it.

You need the **break-glass key** (kept offline; created by
`scripts/b2-setup-keys.ps1`). It is the only key with `deleteFiles` and
`bypassGovernance`.

1. Delete it from the live site first (admin: remove the photo, then purge
   it from the trash or wait for the 30-day purge), so the next backup run
   doesn't upload it again.
2. In PowerShell, with the break-glass key:

   ```powershell
   $id = Read-Host 'break-glass keyID'
   $key = Read-Host 'break-glass applicationKey'
   $auth = Invoke-RestMethod -Uri 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account' `
     -Headers @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${id}:${key}")) }
   $api = $auth.apiInfo.storageApi.apiUrl
   ```

3. List every version of the file (deleted ones included) and delete each,
   bypassing the lock:

   ```powershell
   $bucketId = '<bucket ID from the Backblaze console>'
   $name = 'media-private/<key>'   # or daily/2026-12-01.json.gz
   $versions = Invoke-RestMethod -Method Post -Uri "$api/b2api/v3/b2_list_file_versions" `
     -Headers @{ Authorization = $auth.authorizationToken } -ContentType 'application/json' `
     -Body (@{ bucketId = $bucketId; startFileName = $name; prefix = $name } | ConvertTo-Json)
   foreach ($v in $versions.files) {
     Invoke-RestMethod -Method Post -Uri "$api/b2api/v3/b2_delete_file_version" `
       -Headers @{ Authorization = $auth.authorizationToken } -ContentType 'application/json' `
       -Body (@{ fileName = $v.fileName; fileId = $v.fileId; bypassGovernance = $true } | ConvertTo-Json)
   }
   ```

4. Note what you deleted and why in docs/PROGRESS.md (no personal details).
