{{/*
Expand the name of the chart.
*/}}
{{- define "astra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this
(by the DNS naming spec). If the release name already contains the chart name,
we omit the chart name to avoid duplication (e.g. "openastra-openastra").
*/}}
{{- define "astra.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart label value — "<chart-name>-<chart-version>".
*/}}
{{- define "astra.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "astra.labels" -}}
helm.sh/chart: {{ include "astra.chart" . }}
{{ include "astra.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels used by the Deployment and Service.
*/}}
{{- define "astra.selectorLabels" -}}
app.kubernetes.io/name: {{ include "astra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Resolve the ServiceAccount name to use.
*/}}
{{- define "astra.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "astra.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolve the name of the application Secret.
When secret.name is explicitly set, use it; otherwise derive it from the
full release name so it is unique per Helm release.
*/}}
{{- define "astra.secretName" -}}
{{- if .Values.secret.name }}
{{- .Values.secret.name }}
{{- else }}
{{- printf "%s-secrets" (include "astra.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Resolve the name of the PostgreSQL Secret.
When postgres.existingSecret.name is set (and secret.create is false),
use the external Secret; otherwise fall back to the chart-managed Secret.
*/}}
{{- define "astra.postgresSecretName" -}}
{{- if and (not .Values.secret.create) .Values.postgres.existingSecret.name }}
{{- .Values.postgres.existingSecret.name }}
{{- else }}
{{- include "astra.secretName" . }}
{{- end }}
{{- end }}

{{/*
Resolve the key inside the postgres Secret that holds PG_PASSWORD.
*/}}
{{- define "astra.postgresPasswordKey" -}}
{{- if and (not .Values.secret.create) .Values.postgres.existingSecret.key }}
{{- .Values.postgres.existingSecret.key }}
{{- else }}
PG_PASSWORD
{{- end }}
{{- end }}
