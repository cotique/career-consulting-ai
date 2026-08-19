// Deploys/updates the API Container App onto the already-existing Container
// Apps Environment and Container Registry (both created by hand — this
// template does not create them).
//
// Resource names are parameters without defaults, on purpose: they name real
// resources in a real subscription, and this file is public. Pass them at
// deploy time.
//
// Usage: az deployment group create -g <resource-group> -f infra/containerapp.bicep \
//          -p imageTag=<tag> environmentName=<env> registryName=<acr> appName=<app> imageName=<image>

@description('Tag of the image to deploy, e.g. a commit SHA or "latest".')
param imageTag string = 'latest'

@description('Name of the existing Container Apps Environment.')
param environmentName string

@description('Name of the existing Azure Container Registry (login server host, without protocol).')
param registryName string

@description('Name of the Container App to create or update.')
param appName string

@description('Repository name of the image inside the registry.')
param imageName string

@description('Region — must match the existing environment/registry.')
param location string = resourceGroup().location

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: '${registry.properties.loginServer}/${imageName}:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, containerApp.id, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d') // AcrPull
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output fqdn string = containerApp.properties.configuration.ingress.fqdn
