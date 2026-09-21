#Requires -Version 7.0
<#
.SYNOPSIS
  Deploys the AI Practice Pipeline to Azure: infrastructure (Bicep), then code.

.DESCRIPTION
  You work across several tenants and subscriptions, so this script never trusts whatever
  `az` happens to be logged into. TenantId and SubscriptionId are required, the script
  switches to them, shows you what it resolved, and asks before it changes anything.

.EXAMPLE
  ./scripts/deploy.ps1 -TenantId 573e37c4-c2a8-4397-a860-6979128f5ac3 -SubscriptionId 7d70637f-bd34-4728-b41e-5a5c9f652d5d

.EXAMPLE
  ./scripts/deploy.ps1 -TenantId <tid> -SubscriptionId <sid> -SkipInfra   # code only, after the first run
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$TenantId,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$SubscriptionId,
  [string]$ResourceGroup = 'rg-zones-ai-pipeline',
  [string]$Location = 'eastus2',
  [ValidateLength(3, 8)][string]$Prefix = 'zpipe',
  [switch]$SkipInfra,
  [switch]$SkipCode,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

function Assert-Exit([string]$What) {
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}
function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name not found. $Hint" }
}

# ---------- 1. Tooling ----------
Require-Command az 'Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli'
Require-Command node 'Install Node 24 or later.'
Require-Command npm 'Install Node 24 or later.'
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node $nodeMajor detected. This project needs Node 24 or later." }

# ---------- 2. Tenant and subscription guard ----------
$acct = az account show -o json 2>$null | ConvertFrom-Json
if (-not $acct -or $acct.tenantId -ne $TenantId) {
  Write-Host "Signing in to tenant $TenantId ..."
  az login --tenant $TenantId --only-show-errors | Out-Null
  Assert-Exit 'az login'
}
az account set --subscription $SubscriptionId
Assert-Exit 'az account set'
$acct = az account show -o json | ConvertFrom-Json
if ($acct.tenantId -ne $TenantId -or $acct.id -ne $SubscriptionId) {
  throw "Resolved tenant/subscription does not match what you asked for. Stopping."
}

Write-Host ''
Write-Host 'About to deploy to:' -ForegroundColor Cyan
Write-Host "  Tenant        $($acct.tenantId)"
Write-Host "  Subscription  $($acct.name) ($($acct.id))"
Write-Host "  Signed in as  $($acct.user.name)"
Write-Host "  Resource grp  $ResourceGroup in $Location"
Write-Host ''
if (-not $Force) {
  $answer = Read-Host 'Type the subscription name exactly to continue'
  if ($answer -ne $acct.name) { throw 'Name did not match. Nothing was changed.' }
}

# ---------- 3. Infrastructure ----------
$outFile = Join-Path $root '.env.deploy'
if (-not $SkipInfra) {
  az group create --name $ResourceGroup --location $Location --only-show-errors | Out-Null
  Assert-Exit 'az group create'

  $me = az ad signed-in-user show --query id -o tsv
  Assert-Exit 'az ad signed-in-user show'

  Write-Host 'Deploying infrastructure (Cosmos, Function App, storage, monitoring). This takes a few minutes...'
  $outputs = az deployment group create `
    --resource-group $ResourceGroup `
    --template-file (Join-Path $root 'infra/main.bicep') `
    --parameters prefix=$Prefix location=$Location adminObjectId=$me `
    --query properties.outputs -o json --only-show-errors | ConvertFrom-Json
  Assert-Exit 'az deployment group create'

  @(
    "COSMOS_ENDPOINT=$($outputs.cosmosEndpoint.value)"
    "COSMOS_DATABASE=$($outputs.cosmosDatabase.value)"
    "COSMOS_CONTAINER=$($outputs.cosmosContainer.value)"
    "FUNCTION_APP_NAME=$($outputs.functionAppName.value)"
    "APP_URL=$($outputs.functionAppUrl.value)"
  ) | Set-Content -Path $outFile -Encoding utf8
  Write-Host "Wrote $outFile (endpoints only, no secrets)."
}

if (-not (Test-Path $outFile)) { throw "$outFile not found. Run once without -SkipInfra first." }
$cfg = @{}
Get-Content $outFile | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $cfg[$Matches[1]] = $Matches[2] } }

# ---------- 4. Code ----------
if (-not $SkipCode) {
  # Stage a clean copy so dev dependencies (exceljs) never ship and your working node_modules is untouched.
  $stage = Join-Path $root '.deploy'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage | Out-Null
  foreach ($item in 'host.json', 'package.json', 'package-lock.json', 'src', 'web') {
    Copy-Item (Join-Path $root $item) -Destination $stage -Recurse
  }
  Push-Location $stage
  try {
    npm ci --omit=dev --no-audit --no-fund
    Assert-Exit 'npm ci'

    if (Get-Command func -ErrorAction SilentlyContinue) {
      Write-Host 'Publishing with Azure Functions Core Tools...'
      func azure functionapp publish $cfg['FUNCTION_APP_NAME'] --javascript
      Assert-Exit 'func azure functionapp publish'
    }
    else {
      Write-Host 'Core Tools (func) not found. Falling back to zip deploy...'
      $zip = Join-Path $root 'app.zip'
      if (Test-Path $zip) { Remove-Item $zip -Force }
      Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
      az functionapp deploy --resource-group $ResourceGroup --name $cfg['FUNCTION_APP_NAME'] --src-path $zip --type zip --only-show-errors
      Assert-Exit 'az functionapp deploy'
      Remove-Item $zip -Force
    }
  }
  finally {
    Pop-Location
  }
}

# ---------- 5. Smoke test ----------
$health = "$($cfg['APP_URL'])/api/health"
Write-Host "Checking $health ..."
$ok = $false
for ($i = 1; $i -le 12 -and -not $ok; $i++) {
  try {
    $r = Invoke-RestMethod -Uri $health -TimeoutSec 30
    if ($r.ok -and $r.store -eq 'cosmos') { $ok = $true }
  }
  catch { Start-Sleep -Seconds 10 }
}
if (-not $ok) {
  Write-Warning 'Health check did not return store=cosmos. Check the Function App logs in Application Insights, and confirm the role assignments finished propagating (can take several minutes).'
  exit 1
}

Write-Host ''
Write-Host "Deployed: $($cfg['APP_URL'])" -ForegroundColor Green
Write-Host 'Next: npm ci ; npm run seed:sample     (fictional data only, until sign in is enabled)'

