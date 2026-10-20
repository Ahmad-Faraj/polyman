variable "project" {
  description = "Google Cloud project id that hosts the verify service."
  type        = string
  default     = "polyman-511913"
}

variable "region" {
  description = "Region of the Cloud Run service, its subnet and the image repository (GCP_REGION in CI)."
  type        = string
  default     = "us-east1"
}

variable "gitlab_project_path" {
  description = "The only GitLab project whose protected main branch may deploy (the WIF attribute condition)."
  type        = string
  default     = "gitlab-ai-hackathon/transcend-october-2026/30770856/showcase"
}
