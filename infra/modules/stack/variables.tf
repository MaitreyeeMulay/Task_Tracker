variable "name" {
  description = "Name prefix for every resource, for example incident-tracker-dev."
  type        = string
}

variable "alert_email" {
  description = "Receives alarm emails and is the SES sender (SES sandbox: also the only allowed recipient)."
  type        = string
  sensitive   = true
}

variable "github_repository" {
  description = "owner/name of the GitHub repository allowed to deploy."
  type        = string
}

variable "app_image" {
  description = "Image for the first task definitions. The deploy pipeline replaces it with a signed digest; the service starts at 0 tasks."
  type        = string
}
