#Requires -Version 7.0
<#
.SYNOPSIS
  Creates the Microsoft Foundry resource and model deployment that power "From transcript", and wires the
  Function App to it. Standalone: it does not touch infra/main.bicep or deploy.ps1.

.DESCRIPTION
  Like deploy.ps1, this never trusts whatever `az` happens to be signed in to. TenantId and SubscriptionId are
  required, the script switches to them, shows what it resolved, and asks before it changes anything.

  What it does, in order:
    1. Creates a Foundry (AIServices) resource with a custom subdomain, which Entra ID authentication requires.
    2. Deploys a chat model to it (default gpt-5.4-mini; the version and the deployment SKU are chosen from what your
       region offers). The deployment is named after the model, so moving to a newer model later is one rerun with
       a new -Model, and the old deployment keeps working until you delete it.
    3. Turns off API key access, so the only way in is Entra ID. Same stance as the Cosmos account.
    4. Gives the Function App's managed identity the "Cognitive Services OpenAI User" role on the resource
       (and you, for local testing, unless -NoLocalAccess).
    5. Sets FOUNDRY_ENDPOINT and FOUNDRY_DEPLOYMENT on the Function App (and FOUNDRY_REASONING_EFFORT for gpt-5 and
       o-series models). That restarts the app.

  It is safe to run again: existing resources, deployments and role assignments are left alone.

.EXAMPLE
  ./scripts/setup-foundry.ps1 -TenantId <tid> -SubscriptionId <sid> -DryRun     # prints the az commands, changes nothing

.EXAMPLE
  ./scripts/setup-foundry.ps1 -TenantId <tid> -SubscriptionId <sid>

.EXAMPLE
  # Model retiring? Deploy the replacement next to it and repoint the app. The old deployment is not touched.
  ./scripts/setup-foundry.ps1 -TenantId <tid> -SubscriptionId <sid> -Model gpt-5.5

.NOTES
  Written from the Azure CLI documentation and not run from the authoring environment. Read the -DryRun output first.
  Data handling: Standard keeps processing in the resource's region, DataZoneStandard keeps it in the US or EU data
  zone, GlobalStandard may process anywhere Microsoft runs the model. For customer transcripts prefer the first two.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$TenantId,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$SubscriptionId,
  [string]$ResourceGroup = 'rg-zones-ai-pipeline',
  [string]$Location = 'eastus2',
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$')][string]$AccountName,
  [string]$DeploymentName,                 # default: transcripts-<model>, for example transcripts-gpt-5-4-mini
  [string]$Model = 'gpt-5.4-mini',
  [string]$ModelVersion,                   # default: the newest version of -Model that your region offers
  [ValidateSet('Auto', 'Standard', 'DataZoneStandard', 'GlobalStandard')][string]$Sku = 'Auto',
  [ValidateRange(1, 1000)][int]$Capacity = 100,   # thousands of tokens per minute. Lower it if quota is short.
  [ValidateSet('Auto', 'Off', 'minimal', 'low', 'medium', 'high')][string]$ReasoningEffort = 'Auto',
  [string]$FunctionAppName,
  [switch]$NoLocalAccess,
  [switch]$DryRun,
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
# Runs az, or just prints the command under -DryRun. Returns the output lines.
function Invoke-Az([string[]]$Rest) {
  if ($DryRun) { Write-Host ("  az " + ($Rest -join ' ')) -ForegroundColor DarkGray; return $null }
  & az @Rest
}

# ---------- 1. Tooling ----------
Require-Command az 'Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli'

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
  throw 'Resolved tenant/subscription does not match what you asked for. Stopping.'
}

if (-not $AccountName) { $AccountName = "zpipe-foundry-$($SubscriptionId.Substring(0, 6).ToLower())" }
if (-not $DeploymentName) { $DeploymentName = 'transcripts-' + (($Model.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')) }
if ($DeploymentName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "Deployment name '$DeploymentName' is not valid. Use letters, digits, dot, dash or underscore." }

# gpt-5 and o-series are reasoning models. They spend hidden tokens thinking, which is wasted effort for pulling fields out
# of a transcript, so the app asks for low effort. Other models reject the parameter, so it is not set for them.
$isReasoning = $Model -match '^(gpt-5|o\d)'
$effort = switch ($ReasoningEffort) { 'Auto' { if ($isReasoning) { 'low' } else { '' } } 'Off' { '' } default { $ReasoningEffort } }

# ---------- 3. Read what already exists ----------
$outFile = Join-Path $root '.env.deploy'
if (-not $FunctionAppName -and (Test-Path $outFile)) {
  $line = Get-Content $outFile | Where-Object { $_ -match '^FUNCTION_APP_NAME=(.+)$' } | Select-Object -First 1
  if ($line) { $FunctionAppName = ($line -replace '^FUNCTION_APP_NAME=', '').Trim() }
}
if (-not $FunctionAppName) { throw 'Function App name not found. Pass -FunctionAppName, or run deploy.ps1 first so .env.deploy exists.' }

az group show --name $ResourceGroup -o none 2>$null
if ($LASTEXITCODE -ne 0) { throw "Resource group $ResourceGroup does not exist in this subscription. Run deploy.ps1 first, or pass -ResourceGroup." }

az functionapp show -g $ResourceGroup -n $FunctionAppName --query id -o tsv 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Function App $FunctionAppName not found in $ResourceGroup." }

# ---------- 4. Pick a deployment SKU this region actually offers ----------
# Listing models is read only, so it runs under -DryRun too. That way the dry run shows the real version and SKU.
$models = az cognitiveservices model list --location $Location -o json --only-show-errors | ConvertFrom-Json
Assert-Exit 'az cognitiveservices model list'
$sameModel = @($models | Where-Object { $_.model.name -eq $Model })
$match = @(if ($ModelVersion) { $sameModel | Where-Object { $_.model.version -eq $ModelVersion } } else { $sameModel | Sort-Object { $_.model.version } -Descending | Select-Object -First 1 })
if ($match.Count -eq 0) {
  if ($sameModel.Count -gt 0) {
    Write-Host "Model $Model has no version $ModelVersion in $Location. Versions that are offered:" -ForegroundColor Yellow
    $sameModel | ForEach-Object { Write-Host "  $($_.model.version)" }
    throw 'Pick one with -ModelVersion, or leave it out to take the newest.'
  }
  $names = @($models | Where-Object { $_.kind -eq 'OpenAI' -and $_.model.name -like 'gpt*' } | ForEach-Object { $_.model.name } | Sort-Object -Unique)
  Write-Host "Model $Model is not offered in $Location. GPT models that are:" -ForegroundColor Yellow
  $names | ForEach-Object { Write-Host "  $_" }
  throw 'Pick one with -Model, or another -Location. Your subscription can also see the list with: az cognitiveservices model list -l <location>'
}
if (-not $ModelVersion) { $ModelVersion = $match[0].model.version }
$offered = @($match[0].model.skus | ForEach-Object { $_.name })
if ($Sku -eq 'Auto') {
  $Sku = @('DataZoneStandard', 'Standard', 'GlobalStandard') | Where-Object { $offered -contains $_ } | Select-Object -First 1
  if (-not $Sku) { throw "None of Standard, DataZoneStandard, GlobalStandard is offered for $Model in $Location (offered: $($offered -join ', '))." }
} elseif ($offered -notcontains $Sku) {
  throw "$Sku is not offered for $Model in $Location (offered: $($offered -join ', '))."
}

Write-Host ''
Write-Host 'About to create or update:' -ForegroundColor Cyan
Write-Host "  Tenant         $($acct.tenantId)"
Write-Host "  Subscription   $($acct.name) ($($acct.id))"
Write-Host "  Signed in as   $($acct.user.name)"
Write-Host "  Resource grp   $ResourceGroup ($Location)"
Write-Host "  Foundry        $AccountName  (AIServices, S0, key access will be disabled)"
Write-Host "  Deployment     $DeploymentName = $Model $ModelVersion, $Sku, capacity $Capacity"
Write-Host "  Reasoning      $(if ($effort) { "effort $effort (FOUNDRY_REASONING_EFFORT)" } else { 'not a reasoning model, no effort setting' })"
Write-Host "  Function App   $FunctionAppName  (settings FOUNDRY_ENDPOINT, FOUNDRY_DEPLOYMENT and the effort setting, then it restarts)"
if ($Sku -eq 'GlobalStandard') { Write-Host '  Note           GlobalStandard can process prompts in any Azure region. Prefer DataZoneStandard or Standard for customer transcripts.' -ForegroundColor Yellow }
if ($DryRun) { Write-Host '  DRY RUN        commands are printed, nothing is changed.' -ForegroundColor Yellow }
Write-Host ''
if (-not $Force -and -not $DryRun) {
  $answer = Read-Host 'Type the subscription name exactly to continue'
  if ($answer -ne $acct.name) { throw 'Name did not match. Nothing was changed.' }
}

# ---------- 5. Foundry resource ----------
$accountId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.CognitiveServices/accounts/$AccountName"
$exists = $false
if (-not $DryRun) {
  az cognitiveservices account show -g $ResourceGroup -n $AccountName -o none 2>$null
  $exists = ($LASTEXITCODE -eq 0)
}
if ($exists) {
  Write-Host "Foundry resource $AccountName already exists, leaving it as it is."
} else {
  Write-Host 'Creating the Foundry resource...'
  Invoke-Az @('cognitiveservices', 'account', 'create', '-g', $ResourceGroup, '-n', $AccountName, '-l', $Location,
    '--kind', 'AIServices', '--sku', 'S0', '--custom-domain', $AccountName, '--yes', '--only-show-errors', '-o', 'none')
  if (-not $DryRun) { Assert-Exit 'az cognitiveservices account create' }
}

# ---------- 6. Model deployment ----------
$deployed = $false
if (-not $DryRun) {
  az cognitiveservices account deployment show -g $ResourceGroup -n $AccountName --deployment-name $DeploymentName -o none 2>$null
  $deployed = ($LASTEXITCODE -eq 0)
}
if ($deployed) {
  # A deployment name that already exists but runs a different model would silently keep serving the old one.
  $cur = az cognitiveservices account deployment show -g $ResourceGroup -n $AccountName --deployment-name $DeploymentName --query properties.model -o json | ConvertFrom-Json
  if ($cur -and $cur.name -and ($cur.name -ne $Model -or ($cur.version -ne $ModelVersion))) {
    throw "Deployment $DeploymentName already exists and runs $($cur.name) $($cur.version), not $Model $ModelVersion. Use a different -DeploymentName (the default includes the model name), or delete that deployment first."
  }
  Write-Host "Deployment $DeploymentName already exists with $Model $ModelVersion, leaving it as it is."
} else {
  Write-Host "Deploying $Model $ModelVersion ($Sku)..."
  Invoke-Az @('cognitiveservices', 'account', 'deployment', 'create', '-g', $ResourceGroup, '-n', $AccountName,
    '--deployment-name', $DeploymentName, '--model-name', $Model, '--model-version', $ModelVersion, '--model-format', 'OpenAI',
    '--sku-name', $Sku, '--sku-capacity', "$Capacity", '--only-show-errors', '-o', 'none')
  if (-not $DryRun -and $LASTEXITCODE -ne 0) {
    Write-Warning "If that was a quota error, rerun with a lower -Capacity (try 30), or raise the quota for $Model ($Sku) in the Foundry portal under Management, Quota."
    throw "az cognitiveservices account deployment create failed (exit code $LASTEXITCODE)."
  }
}

# ---------- 7. Entra ID only ----------
Write-Host 'Turning off API key access...'
Invoke-Az @('resource', 'update', '--ids', $accountId, '--set', 'properties.disableLocalAuth=true', '--only-show-errors', '-o', 'none')
if (-not $DryRun -and $LASTEXITCODE -ne 0) {
  Write-Warning 'Could not disable key access from the CLI. Do it in the portal: the Foundry resource, Resource Management, Keys and Endpoint, or set disableLocalAuth on the resource.'
}

# ---------- 8. Roles ----------
$role = 'Cognitive Services OpenAI User'
function Grant-Role([string]$ObjectId, [string]$Type, [string]$Label) {
  if ($DryRun) {
    Invoke-Az @('role', 'assignment', 'create', '--assignee-object-id', $ObjectId, '--assignee-principal-type', $Type, '--role', "`"$role`"", '--scope', $accountId)
    return
  }
  $have = az role assignment list --assignee $ObjectId --role $role --scope $accountId --query '[0].id' -o tsv 2>$null
  if ($have) { Write-Host "$Label already has $role."; return }
  az role assignment create --assignee-object-id $ObjectId --assignee-principal-type $Type --role $role --scope $accountId --only-show-errors -o none
  Assert-Exit "Granting $role to $Label"
  Write-Host "Granted $role to $Label."
}

$principal = if ($DryRun) { '<function-app-principal-id>' } else { az functionapp identity show -g $ResourceGroup -n $FunctionAppName --query principalId -o tsv }
if (-not $DryRun) { Assert-Exit 'az functionapp identity show' }
if (-not $principal) { throw "The Function App has no system assigned identity. Run deploy.ps1 (infrastructure) first." }
Grant-Role $principal 'ServicePrincipal' "the Function App ($FunctionAppName)"

if (-not $NoLocalAccess) {
  $me = if ($DryRun) { '<your-object-id>' } else { az ad signed-in-user show --query id -o tsv }
  if (-not $DryRun) { Assert-Exit 'az ad signed-in-user show' }
  Grant-Role $me 'User' "you ($($acct.user.name))"
}

# ---------- 9. Wire the app ----------
$endpoint = "https://$AccountName.openai.azure.com/"
if (-not $DryRun) {
  $eps = az cognitiveservices account show -g $ResourceGroup -n $AccountName --query properties.endpoints -o json | ConvertFrom-Json
  $found = $eps.PSObject.Properties | Where-Object { $_.Name -like 'OpenAI*' } | Select-Object -First 1
  if ($found -and $found.Value) { $endpoint = $found.Value }
}
Write-Host 'Pointing the Function App at the deployment (it restarts)...'
$settings = @("FOUNDRY_ENDPOINT=$endpoint", "FOUNDRY_DEPLOYMENT=$DeploymentName")
if ($effort) { $settings += "FOUNDRY_REASONING_EFFORT=$effort" }
Invoke-Az (@('functionapp', 'config', 'appsettings', 'set', '-g', $ResourceGroup, '-n', $FunctionAppName, '--settings') + $settings + @('--only-show-errors', '-o', 'none'))
if (-not $DryRun) { Assert-Exit 'az functionapp config appsettings set' }
if (-not $effort) {
  # A previous reasoning model may have left this behind, and a non-reasoning model would reject it.
  Invoke-Az @('functionapp', 'config', 'appsettings', 'delete', '-g', $ResourceGroup, '-n', $FunctionAppName, '--setting-names', 'FOUNDRY_REASONING_EFFORT', '--only-show-errors', '-o', 'none')
}

# Other deployments on the account are usually the model being retired. Print the command, never run it.
if (-not $DryRun) {
  $all = @(az cognitiveservices account deployment list -g $ResourceGroup -n $AccountName --query '[].name' -o json --only-show-errors | ConvertFrom-Json)
  $others = @($all | Where-Object { $_ -and $_ -ne $DeploymentName })
  if ($others.Count -gt 0) {
    Write-Host ''
    Write-Host "Other deployments on $AccountName that the app no longer uses: $($others -join ', ')" -ForegroundColor Yellow
    Write-Host 'Once you have run a transcript against the new one, remove the old one so it stops holding quota:'
    $others | ForEach-Object { Write-Host "  az cognitiveservices account deployment delete -g $ResourceGroup -n $AccountName --deployment-name $_" }
  }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Endpoint    $endpoint"
Write-Host "  Deployment  $DeploymentName ($Model $ModelVersion)"
if ($effort) { Write-Host "  Effort      $effort" }
Write-Host ''
Write-Host 'Role assignments can take a few minutes to take effect. A first transcript that fails with "not allowed" is usually just that.'
Write-Host 'To try it against the real model from your machine (uses your az login, so sign in to this tenant first):'
Write-Host "  `$env:AZURE_TENANT_ID = '$TenantId'; `$env:FOUNDRY_ENDPOINT = '$endpoint'; `$env:FOUNDRY_DEPLOYMENT = '$DeploymentName'; $(if ($effort) { "`$env:FOUNDRY_REASONING_EFFORT = '$effort'; " })npm run dev"
Write-Host ''
Write-Host 'Remember: settings made here are not in infra/main.bicep. If you later redeploy infrastructure, check that the FOUNDRY_ app settings survived.'
