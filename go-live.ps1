# Puts the app live in one go: loads the real data into Atlas, creates the three logins,
# gives Vercel its settings and deploys to production. Safe to run again.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\go-live.ps1

Set-Location $PSScriptRoot
$loginsFile = Join-Path $PSScriptRoot 'deploy-logins.txt'

function Fail($message) {
  Write-Host ''
  Write-Host $message -ForegroundColor Red
  exit 1
}

function New-Secret([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return ([BitConverter]::ToString($buffer) -replace '-', '').ToLower()
}

# Letters and digits only, so the passwords are easy to copy and type.
function New-Password {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  $buffer = New-Object byte[] 18
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return -join ($buffer | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function Read-Default($prompt, $default) {
  $answer = Read-Host "$prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}

Write-Host ''
Write-Host 'Step 1 of 4: database connection' -ForegroundColor Cyan
Write-Host 'In Atlas: your cluster > Connect > Drivers > copy the connection string.'
$uri = (Read-Host 'Paste the connection string').Trim()
if ($uri -notmatch '^mongodb(\+srv)?://') { Fail 'That does not look like a MongoDB connection string. It should start with mongodb+srv://' }

if ($uri -match '<db_password>|<password>') {
  $secure = Read-Host 'Database user password (hidden)' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  # Characters such as @ must be encoded inside a connection string.
  $uri = $uri -replace '<db_password>|<password>', [uri]::EscapeDataString($plain)
}

# The app keeps its data in a database named "budget".
if ($uri -match '\.net/\?') { $uri = $uri -replace '\.net/\?', '.net/budget?' }
elseif ($uri -match '\.net/?$') { $uri = ($uri -replace '/$', '') + '/budget' }
elseif ($uri -match '\.net\?') { $uri = $uri -replace '\.net\?', '.net/budget?' }

$env:MONGODB_URI = $uri

Write-Host ''
Write-Host 'Step 2 of 4: loading 90 months of CGA figures' -ForegroundColor Cyan
npm run seed:data --prefix server
if ($LASTEXITCODE -ne 0) { Fail 'Loading the data failed. Check the password and that Network Access allows 0.0.0.0/0, then run this again.' }

Write-Host ''
Write-Host 'Step 3 of 4: logins for the live site' -ForegroundColor Cyan
Write-Host 'Press Enter to accept each suggested email, or type your own.'
$accounts = @(
  @{ Role = 'Admin'; Email = (Read-Default 'Admin email' 'admin@budgetmonitor.example'); Prefix = 'SEED_ADMIN' },
  @{ Role = 'Finance Officer'; Email = (Read-Default 'Finance Officer email' 'finance@budgetmonitor.example'); Prefix = 'DEMO_FINANCE' },
  @{ Role = 'Department Head, Petroleum Subsidy'; Email = (Read-Default 'Department Head email' 'head@budgetmonitor.example'); Prefix = 'DEMO_HEAD' }
)
foreach ($account in $accounts) {
  $account.Password = New-Password
  Set-Item -Path "env:$($account.Prefix)_EMAIL" -Value $account.Email
  Set-Item -Path "env:$($account.Prefix)_PASSWORD" -Value $account.Password
}
$env:DEMO_HEAD_DEPARTMENT = 'PETROLEUM'
npm run seed:users --prefix server
if ($LASTEXITCODE -ne 0) { Fail 'Creating the logins failed. See the message above.' }

$lines = @('Budget Monitor: live-site logins', "Created $(Get-Date -Format 'yyyy-MM-dd HH:mm')", 'Only accounts that did not exist before this run were created with these passwords.', '')
foreach ($account in $accounts) { $lines += "$($account.Role)`r`n  Email:    $($account.Email)`r`n  Password: $($account.Password)`r`n" }
Set-Content -Path $loginsFile -Value $lines -Encoding UTF8

Write-Host ''
Write-Host 'Step 4 of 4: Vercel settings and deployment' -ForegroundColor Cyan
$settings = [ordered]@{ MONGODB_URI = $uri; SESSION_SECRET = (New-Secret 32); CRON_SECRET = (New-Secret 32) }
foreach ($name in $settings.Keys) {
  # Replace any earlier value, so running this again is safe.
  cmd /c "npx vercel env rm $name production --yes >nul 2>&1"
  $settings[$name] | npx vercel env add $name production
  if ($LASTEXITCODE -ne 0) { Fail "Could not save $name in Vercel. See the message above." }
}

npx vercel deploy --prod --yes
if ($LASTEXITCODE -ne 0) { Fail 'The deployment failed. See the message above.' }

Write-Host ''
Write-Host 'Done. The live address is the Production line above.' -ForegroundColor Green
Write-Host "Your three logins are in $loginsFile"
