// AI Practice Pipeline. Resource group scope.
//
// Function App (Flex Consumption, Node 24, system assigned identity) serves the page and the API.
// Cosmos DB serverless with key auth DISABLED, so the only way in is Entra ID. The Function App's
// identity and the person running the import scripts get Cosmos data plane roles. No secrets exist.
//
// Not yet included, on purpose (MVP): sign in, private endpoints, custom domain.
// See README "Before real customer data".

targetScope = 'resourceGroup'

@minLength(3)
@maxLength(8)
@description('Short lowercase prefix used in resource names.')
param prefix string = 'zpipe'

param location string = resourceGroup().location

@description('Object ID of the person who runs the seed and import scripts. Gets Cosmos data plane access. Leave empty to skip.')
param adminObjectId string = ''

@minValue(1)
@maxValue(100)
@description('Upper bound on Function App instances. Ten is plenty for a team tracker.')
param maxInstances int = 10

var suffix = take(uniqueString(resourceGroup().id), 8)
var storageName = toLower('${prefix}st${take(uniqueString(resourceGroup().id), 12)}')
var cosmosName = toLower('${prefix}-cosmos-${suffix}')
var functionName = toLower('${prefix}-api-${suffix}')
var planName = '${prefix}-plan-${suffix}'
var logsName = '${prefix}-logs-${suffix}'
var insightsName = '${prefix}-appi-${suffix}'
var databaseName = 'pipeline'
var containerName = 'items'
var deploymentContainerName = 'app-package'

// Built in role definition IDs.
var storageBlobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var storageQueueDataContributor = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var storageTableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
// Cosmos DB Built-in Data Contributor (data plane, not an Azure RBAC role).
var cosmosDataContributorId = '00000000-0000-0000-0000-000000000002'

// ---------- Observability ----------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logsName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

// ---------- Storage (Functions host state and deployment package). No shared keys. ----------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deploymentContainerName
  properties: { publicAccess: 'None' }
}

// ---------- Cosmos DB (serverless, Entra ID only) ----------

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      { name: 'EnableServerless' }
    ]
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    minimalTlsVersion: 'Tls12'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: databaseName
  properties: {
    resource: { id: databaseName }
  }
}

// Partition key is the record type ("opp" or "settings"). Listing all opportunities is a single
// partition query, which is right for a few thousand rows at most.
resource container 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: containerName
  properties: {
    resource: {
      id: containerName
      partitionKey: {
        paths: ['/type']
        kind: 'Hash'
        version: 2
      }
    }
  }
}

// ---------- Function App (Flex Consumption, Linux, Node 24) ----------

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  kind: 'functionapp'
  sku: {
    tier: 'FlexConsumption'
    name: 'FC1'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maxInstances
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '24'
      }
    }
    siteConfig: {
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
        { name: 'COSMOS_DATABASE', value: databaseName }
        { name: 'COSMOS_CONTAINER', value: containerName }
      ]
    }
  }
  dependsOn: [
    deploymentContainer
  ]
}

// ---------- Role assignments ----------

resource blobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, storageBlobDataOwner)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwner)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource queueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, storageQueueDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributor)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource tableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, storageTableDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributor)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource apiCosmosAccess 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmos
  name: guid(cosmos.id, functionApp.id, cosmosDataContributorId)
  properties: {
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${cosmosDataContributorId}'
    principalId: functionApp.identity.principalId
    scope: cosmos.id
  }
}

resource adminCosmosAccess 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = if (!empty(adminObjectId)) {
  parent: cosmos
  name: guid(cosmos.id, adminObjectId, cosmosDataContributorId)
  properties: {
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${cosmosDataContributorId}'
    principalId: adminObjectId
    scope: cosmos.id
  }
}

// ---------- Outputs (none are secrets) ----------

output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output cosmosDatabase string = databaseName
output cosmosContainer string = containerName

