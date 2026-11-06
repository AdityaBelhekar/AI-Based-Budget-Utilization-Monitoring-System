# Saves the Atlas connection string in Vercel and redeploys. Touches nothing else: data and logins stay as they are.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\set-database-url.ps1

Set-Location $PSScriptRoot

function Fail($message) {
  Write-Host ''
  Write-Host $message -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'In Atlas: your cluster > Connect > Drivers > copy the connection string.'
$uri = (Read-Host 'Paste the connection string').Trim()
if ($uri -notmatch '^mongodb(\+srv)?://') { Fail 'That does not look like a MongoDB connection string. It should start with mongodb+srv://' }

if ($uri -match '<db_password>|<password>') {
  $secure = Read-Host 'Database user password (hidden)' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  $uri = $uri -replace '<db_password>|<password>', [uri]::EscapeDataString($plain)
}
if ($uri -match '\.net/\?') { $uri = $uri -replace '\.net/\?', '.net/budget?' }
elseif ($uri -match '\.net/?$') { $uri = ($uri -replace '/$', '') + '/budget' }
elseif ($uri -match '\.net\?') { $uri = $uri -replace '\.net\?', '.net/budget?' }

# Sign in first if needed, so no login prompt can swallow the value.
npx vercel whoami
if ($LASTEXITCODE -ne 0) { Fail 'Sign in to Vercel when asked, then run this again.' }

$uri | npx vercel env add MONGODB_URI --environment production --sensitive --force --yes
if ($LASTEXITCODE -ne 0) { Fail 'Could not save MONGODB_URI in Vercel. See the message above.' }

npx vercel deploy --prod --yes
if ($LASTEXITCODE -ne 0) { Fail 'The deployment failed. See the message above.' }

Write-Host ''
Write-Host 'Done. Open https://budget-monitor-eight.vercel.app and sign in with a login from deploy-logins.txt' -ForegroundColor Green
